/* ============================================================================
 * backends/api/gemini.mjs — Google AI Studio (Gemini) API provider
 *
 * GEMINI_API_KEY 가 secrets 에 있으면 서버 모드 provider("google") 로 노출된다.
 * capability: text 만(이미지/영상 false → 코어가 자동 disabled).
 * 모델은 최신 기본값 사용(GEMINI_TEXT_MODEL 로 조정 가능).
 * ========================================================================== */

const TEXT_TIMEOUT_MS = Number(process.env.GEMINI_TEXT_TIMEOUT_MS) || 120000;
const BASE = (process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");

async function callText(key, model, prompt) {
  const t0 = Date.now();
  try {
    const resp = await fetch(BASE + "/models/" + encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(key), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      signal: AbortSignal.timeout(TEXT_TIMEOUT_MS),
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      const msg = data?.error?.message || data?.message || "";
      return { ok: false, error: "Gemini 오류 HTTP " + resp.status + (msg ? ": " + msg : ""), durationMs: Date.now() - t0 };
    }
    const cand = (data?.candidates || [])[0];
    const output = ((cand?.content?.parts) || [])
      .map((p) => p && typeof p.text === "string" ? p.text : "")
      .filter(Boolean)
      .join("\n")
      .trim();
    return {
      ok: !!output,
      output,
      command: "Gemini " + model,
      durationMs: Date.now() - t0,
      error: output ? undefined : ("Gemini 응답이 비어 있습니다." + (cand?.finishReason ? " (" + cand.finishReason + ")" : "")),
    };
  } catch (e) {
    const msg = e && e.name === "TimeoutError" ? `시간 초과(${Math.round(TEXT_TIMEOUT_MS / 1000)}s)` : (e && e.message || String(e));
    return { ok: false, error: "Gemini 호출 실패: " + msg, durationMs: Date.now() - t0 };
  }
}

export function makeGeminiProvider(secrets, env) {
  env = env || process.env;
  const textModel = env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";   // 최신 기본값
  const imageModel = env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";   // 나노바나나(이미지 생성·편집)
  const videoModel = env.GEMINI_VIDEO_MODEL || "veo-3.1-fast-generate-preview";   // Veo(영상) 3.1 Fast
  const VID_TIMEOUT_MS = Number(env.GEMINI_VIDEO_HTTP_TIMEOUT_MS) || 60000;
  const IMG_TIMEOUT_MS = Number(env.GEMINI_IMAGE_HTTP_TIMEOUT_MS) || 280000;
  // 이미지 생성(나노바나나) — generateContent, inlineData 이미지 반환. 참조 이미지(image) 옵션.
  async function callImage(key, model, prompt, image) {
    try {
      const parts = [{ text: String(prompt || "") }];
      if (image && image.b64) parts.push({ inlineData: { mimeType: image.mime || "image/jpeg", data: image.b64 } });
      const body = { contents: [{ parts }], generationConfig: { responseModalities: ["IMAGE"] } };
      const resp = await fetch(BASE + "/models/" + encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(key), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(IMG_TIMEOUT_MS),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) return { ok: false, error: "Gemini 이미지 오류 HTTP " + resp.status + (data?.error?.message ? ": " + data.error.message : "") };
      const cps = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
      const imgp = cps.find((p) => p && p.inlineData && p.inlineData.data);
      if (!imgp) { const t = (cps.find((p) => p && p.text) || {}).text || ""; return { ok: false, error: "Gemini 이미지 응답이 없습니다." + (t ? " (" + t.slice(0, 80) + ")" : "") }; }
      const buf = Buffer.from(imgp.inlineData.data, "base64");
      const mime = imgp.inlineData.mimeType || "image/png";
      const ext = mime.indexOf("jpeg") >= 0 || mime.indexOf("jpg") >= 0 ? "jpg" : (mime.indexOf("webp") >= 0 ? "webp" : "png");
      return { ok: true, buf, ext, mime };
    } catch (e) {
      const msg = e && e.name === "TimeoutError" ? `시간 초과(${Math.round(IMG_TIMEOUT_MS / 1000)}s)` : (e && e.message || String(e));
      return { ok: false, error: "Gemini 이미지 호출 실패: " + msg };
    }
  }
  // 영상 생성 시작 — Veo predictLongRunning(비동기). operation name 반환.
  async function startVideo({ prompt, aspect, image, model }) {
    try {
      const inst = { prompt: String(prompt || "") };
      if (image && image.b64) inst.image = { bytesBase64Encoded: image.b64, mimeType: image.mime || "image/jpeg" };
      const body = { instances: [inst], parameters: { aspectRatio: aspect || "9:16" } };
      const useModel = (model || "").trim() || videoModel;
      const resp = await fetch(BASE + "/models/" + encodeURIComponent(useModel) + ":predictLongRunning?key=" + encodeURIComponent(secrets.GEMINI_API_KEY), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(VID_TIMEOUT_MS),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) return { ok: false, error: "Veo 시작 오류 HTTP " + resp.status + (data?.error?.message ? ": " + data.error.message : "") };
      const op = data && data.name;
      if (!op) return { ok: false, error: "Veo operation name 이 없습니다." };
      return { ok: true, op };
    } catch (e) { return { ok: false, error: "Veo 시작 실패: " + (e && e.message || e) }; }
  }
  // 진행 폴링 — 완료면 영상 바이트 반환(uri 다운로드 또는 base64).
  async function pollVideo({ op }) {
    try {
      const resp = await fetch(BASE + "/" + String(op).replace(/^\/+/, "") + "?key=" + encodeURIComponent(secrets.GEMINI_API_KEY), { signal: AbortSignal.timeout(VID_TIMEOUT_MS) });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) return { ok: false, error: "Veo 폴링 오류 HTTP " + resp.status + (data?.error?.message ? ": " + data.error.message : "") };
      if (!data || !data.done) return { ok: true, done: false };
      if (data.error) return { ok: false, error: "Veo 생성 오류: " + (data.error.message || JSON.stringify(data.error)) };
      const r = data.response || {};
      const samples = (r.generateVideoResponse && r.generateVideoResponse.generatedSamples)
        || r.generatedVideos || r.generatedSamples || (r.predictions || []);
      const first = samples && samples[0];
      const vid = first && (first.video || first);
      const uri = vid && (vid.uri || vid.videoUri || vid.url);
      const b64 = vid && (vid.bytesBase64Encoded || vid.videoBytes);
      if (b64) return { ok: true, done: true, buf: Buffer.from(b64, "base64"), ext: "mp4", mime: "video/mp4" };
      if (uri) {
        const dl = await fetch(uri + (uri.includes("key=") ? "" : ((uri.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(secrets.GEMINI_API_KEY))), { signal: AbortSignal.timeout(VID_TIMEOUT_MS) });
        if (!dl.ok) return { ok: false, error: "Veo 영상 다운로드 실패 HTTP " + dl.status };
        const buf = Buffer.from(await dl.arrayBuffer());
        return { ok: true, done: true, buf, ext: "mp4", mime: "video/mp4" };
      }
      return { ok: false, error: "Veo 응답에서 영상 URI/바이트를 찾지 못했습니다." };
    } catch (e) { return { ok: false, error: "Veo 폴링 실패: " + (e && e.message || e) }; }
  }
  async function listRawModels() {
    try {
      const resp = await fetch(BASE + "/models?key=" + encodeURIComponent(secrets.GEMINI_API_KEY) + "&pageSize=300", { signal: AbortSignal.timeout(VID_TIMEOUT_MS) });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) return { ok: false, error: "ListModels HTTP " + resp.status + (data?.error?.message ? ": " + data.error.message : "") };
      return { ok: true, models: (data && data.models || []).map((m) => ({ name: m.name, methods: m.supportedGenerationMethods || [] })) };
    } catch (e) { return { ok: false, error: "ListModels 실패: " + (e && e.message || e) }; }
  }
  return {
    id: "google",
    label: "Google AI Studio (Gemini)",
    capabilities: { text: true, image: true, video: true },
    listRawModels,
    enabled: (s) => !!((s || secrets) || {}).GEMINI_API_KEY,
    models: () => [
      { id: "gemini-2.5-flash", tag: "최신" },
      { id: "gemini-2.5-pro", tag: "고성능" },
    ],
    imageModels: () => [ { id: "gemini-2.5-flash-image", name: "나노바나나 (Gemini 2.5 Flash Image)", tag: "" } ],
    runText: ({ model, prompt }) => callText(secrets.GEMINI_API_KEY, (model || "").trim() || textModel, prompt),
    runImage: (a) => {
      let image = null;
      const mm = /^data:([^;]+);base64,(.+)$/.exec(String(a.refImage || ""));
      if (mm) image = { mime: mm[1], b64: mm[2] };
      return callImage(secrets.GEMINI_API_KEY, (a.imageModel || "").trim() || imageModel, a.prompt, image);
    },
    startVideo,
    pollVideo,
  };
}
