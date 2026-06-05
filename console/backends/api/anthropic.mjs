/* ============================================================================
 * backends/api/anthropic.mjs — Anthropic(Claude) API provider
 *
 * ANTHROPIC_API_KEY 가 secrets 에 있으면 서버 모드 provider 로 노출된다.
 * capability: text 만(이미지/영상 false → 코어가 자동 disabled).
 * ========================================================================== */

const TEXT_TIMEOUT_MS = Number(process.env.ANTHROPIC_TEXT_TIMEOUT_MS) || 120000;
const BASE = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1").replace(/\/+$/, "");
const API_VERSION = process.env.ANTHROPIC_VERSION || "2023-06-01";

async function callText(key, model, prompt) {
  const t0 = Date.now();
  try {
    const resp = await fetch(BASE + "/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": API_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, max_tokens: 4096, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(TEXT_TIMEOUT_MS),
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      const msg = data?.error?.message || data?.message || "";
      return { ok: false, error: "Anthropic 오류 HTTP " + resp.status + (msg ? ": " + msg : ""), durationMs: Date.now() - t0 };
    }
    const output = (data?.content || [])
      .map((part) => part && part.type === "text" ? part.text : "")
      .filter(Boolean)
      .join("\n")
      .trim();
    return {
      ok: !!output,
      output,
      command: "Anthropic " + model,
      durationMs: Date.now() - t0,
      error: output ? undefined : "Anthropic 응답이 비어 있습니다.",
    };
  } catch (e) {
    const msg = e && e.name === "TimeoutError" ? `시간 초과(${Math.round(TEXT_TIMEOUT_MS / 1000)}s)` : (e && e.message || String(e));
    return { ok: false, error: "Anthropic 호출 실패: " + msg, durationMs: Date.now() - t0 };
  }
}

export function makeAnthropicProvider(secrets, env) {
  env = env || process.env;
  return {
    id: "anthropic",
    label: "Anthropic API (Claude)",
    capabilities: { text: true, image: false, video: false },
    enabled: (s) => !!((s || secrets) || {}).ANTHROPIC_API_KEY,
    models: () => [
      { id: "claude-sonnet-4-6", tag: "일반" },
      { id: "claude-opus-4-8", tag: "고성능" },
      { id: "claude-haiku-4-5-20251001", tag: "저렴/빠름" },
    ],
    runText: ({ model, prompt }) => callText(secrets.ANTHROPIC_API_KEY, (model || "").trim() || "claude-sonnet-4-6", prompt),
  };
}
