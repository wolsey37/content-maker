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

// 콘텐츠 유형(세로형: 카드뉴스·피드 4:5, 스토리·릴스 9:16)에 맞춰 세로 size 를 강제해 결과 비율을 일관되게 만든다.
// (size 를 안 보내면 모델이 정사각/auto 로 들쭉날쭉 생성 → 갤러리 크기 불일치의 원인.) 모델별 지원 size 가 달라 model 도 반영.
//   gpt-image 계열: 1024x1024 / 1536x1024 / 1024x1536(세로) / auto
function sizeForKind(kind, model) {
  const k = String(kind || "").toLowerCase();
  const portrait = k === "card" || k === "feed" || k === "story" || k === "reels";
  if (!portrait) return "auto";
  return "1024x1536";
}
// 콘솔에서 선택 가능한 이미지 모델(텍스트 모델과 별개)
const IMAGE_MODELS = [
  { id: "gpt-image-1", name: "gpt-image-1", tag: "" },
  { id: "gpt-image-2", name: "gpt-image-2", tag: "" },
];
const IMAGE_MODEL_IDS = IMAGE_MODELS.map((m) => m.id);
async function callImage(key, model, prompt, size) {
  try {
    const body = { model, prompt, n: 1 };
    if (size) body.size = size;   // 비율 일관성을 위해 명시(미지정 시 모델 기본값 = 정사각/auto)
    const resp = await fetch(BASE + "/images/generations", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
    imageModels: () => IMAGE_MODELS,
    runText: ({ model, prompt }) => callText(secrets.OPENAI_API_KEY, (model || "").trim() || textModel, prompt),
    runImage: ({ prompt, kind, model }) => {
      const m = (model || "").toString().trim();
      const im = IMAGE_MODEL_IDS.includes(m) ? m : imageModel;   // 허용 목록 검증(임의 모델 주입 방지)
      return callImage(secrets.OPENAI_API_KEY, im, prompt, sizeForKind(kind, im));
    },
  };
}
