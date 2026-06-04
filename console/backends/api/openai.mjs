/* ============================================================================
 * backends/api/openai.mjs — OpenAI API provider (text + image)
 *
 *   text  : POST /v1/chat/completions → choices[0].message.content
 *   image : POST /v1/images/generations (gpt-image-1) → b64_json → {buf,ext,mime} (저장은 코어)
 *   video : 미지원(capabilities.video=false → 코어가 disabled 응답)
 *
 * 의존성 0: fetch 로 직접 REST 호출. 키는 secrets 에서 주입.
 * ========================================================================== */

import { detectImage } from "../../util.mjs";

const TEXT_TIMEOUT_MS = Number(process.env.OPENAI_TEXT_TIMEOUT_MS) || 120000;
const IMAGE_TIMEOUT_MS = Number(process.env.OPENAI_IMAGE_TIMEOUT_MS) || 180000;
const BASE = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");

async function callText(key, model, prompt) {
  const t0 = Date.now();
  try {
    const resp = await fetch(BASE + "/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(TEXT_TIMEOUT_MS),
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) return { ok: false, error: "OpenAI 오류 HTTP " + resp.status + (data?.error?.message ? ": " + data.error.message : ""), durationMs: Date.now() - t0 };
    const output = data?.choices?.[0]?.message?.content || "";
    return { ok: !!output, output, command: "OpenAI " + model, durationMs: Date.now() - t0, error: output ? undefined : "OpenAI 응답이 비어 있습니다." };
  } catch (e) {
    const msg = e && e.name === "TimeoutError" ? `시간 초과(${Math.round(TEXT_TIMEOUT_MS / 1000)}s)` : (e && e.message || String(e));
    return { ok: false, error: "OpenAI 호출 실패: " + msg, durationMs: Date.now() - t0 };
  }
}

async function callImage(key, model, prompt) {
  try {
    const resp = await fetch(BASE + "/images/generations", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, n: 1 }),
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) return { ok: false, error: "OpenAI 이미지 오류 HTTP " + resp.status + (data?.error?.message ? ": " + data.error.message : "") };
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) return { ok: false, error: "OpenAI 이미지 응답에 b64_json 이 없습니다." };
    const buf = Buffer.from(b64, "base64");
    const det = detectImage(buf) || { ext: "png", mime: "image/png" };
    return { ok: true, buf, ext: det.ext, mime: det.mime };
  } catch (e) {
    const msg = e && e.name === "TimeoutError" ? `시간 초과(${Math.round(IMAGE_TIMEOUT_MS / 1000)}s)` : (e && e.message || String(e));
    return { ok: false, error: "OpenAI 이미지 호출 실패: " + msg };
  }
}

export function makeOpenAIProvider(secrets, env) {
  env = env || process.env;
  const textModel = env.OPENAI_TEXT_MODEL || "gpt-5.5";
  const imageModel = env.OPENAI_IMAGE_MODEL || "gpt-image-1";
  return {
    id: "openai",
    label: "OpenAI API",
    capabilities: { text: true, image: true, video: false },
    enabled: (s) => !!((s || secrets) || {}).OPENAI_API_KEY,
    models: () => [
      { id: "gpt-5.5", tag: "최신·권장" },
      { id: "gpt-5.4", tag: "이전 세대" },
      { id: "gpt-5.4-mini", tag: "저렴·빠름" },
    ],
    runText: ({ model, prompt }) => callText(secrets.OPENAI_API_KEY, (model || "").trim() || textModel, prompt),
    runImage: ({ prompt }) => callImage(secrets.OPENAI_API_KEY, imageModel, prompt),
  };
}
