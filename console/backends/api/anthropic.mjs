/* ============================================================================
 * backends/api/anthropic.mjs — Anthropic(Claude) API provider 스텁
 *
 * 확장 지점 데모: ANTHROPIC_API_KEY 가 secrets 에 있으면 enabled → /health·/models 에 노출.
 * runText 본문은 아직 미구현(스텁) — 키가 준비되면 /v1/messages 호출을 채우면 활성화된다.
 * capability: text 만(이미지/영상 false → 코어가 자동 disabled).
 * ========================================================================== */

// TODO(확장): 키 준비 시 아래 callText 를 /v1/messages 로 구현.
// async function callText(key, model, prompt) {
//   const resp = await fetch("https://api.anthropic.com/v1/messages", {
//     method:"POST",
//     headers:{ "x-api-key":key, "anthropic-version":"2023-06-01", "Content-Type":"application/json" },
//     body: JSON.stringify({ model, max_tokens:4096, messages:[{role:"user",content:prompt}] }),
//   });
//   const data = await resp.json();
//   ... return { ok, output: data.content?.[0]?.text, command:"Anthropic "+model };
// }

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
    runText: async ({ model, prompt }) => ({
      ok: false,
      error: "Anthropic API 백엔드는 아직 구현되지 않았습니다(스텁). secrets 에 ANTHROPIC_API_KEY 추가 + anthropic.mjs 의 /v1/messages 연동을 채우면 활성화됩니다.",
    }),
  };
}
