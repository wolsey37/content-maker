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
  return {
    id: "google",
    label: "Google AI Studio (Gemini)",
    capabilities: { text: true, image: false, video: false },
    enabled: (s) => !!((s || secrets) || {}).GEMINI_API_KEY,
    models: () => [
      { id: "gemini-2.5-flash", tag: "최신" },
      { id: "gemini-2.5-pro", tag: "고성능" },
    ],
    runText: ({ model, prompt }) => callText(secrets.GEMINI_API_KEY, (model || "").trim() || textModel, prompt),
  };
}
