/* ============================================================================
 * backends/api/index.mjs — API provider 레지스트리 (확장 지점)
 *
 *   secrets(키 저장소)를 로드하고, 등록된 provider 중 enabled(secrets) 인 것만 노출한다.
 *   새 provider 추가 = REGISTRY 에 make 함수 한 줄 + 해당 키를 secrets 에 넣기. 코어/클라이언트 무수정.
 *
 *   backend = { kind:"api", providers:{id->provider}, detectAll(), listModels() }
 *     - detectAll(): 등록된 모든 provider 의 활성 여부 맵(/health 표시용)
 *     - listModels(): 활성 provider 의 모델 목록
 * ========================================================================== */

import { loadSecrets } from "./secrets.mjs";
import { makeOpenAIProvider } from "./openai.mjs";
import { makeAnthropicProvider } from "./anthropic.mjs";

// 등록 순서 = 표시 우선순위. 새 provider 는 여기 한 줄.
const REGISTRY = [makeOpenAIProvider, makeAnthropicProvider];

export async function makeApiBackend(env) {
  env = env || process.env;
  const secrets = await loadSecrets(env);

  const all = REGISTRY.map((make) => make(secrets, env));
  const providers = {};
  for (const p of all) if (p.enabled(secrets)) providers[p.id] = p;

  const detectAll = async () => { const o = {}; for (const p of all) o[p.id] = !!p.enabled(secrets); return o; };
  const listModels = async () => { const o = {}; for (const id of Object.keys(providers)) o[id] = { models: providers[id].models(), source: providers[id].label }; return o; };

  return { kind: "api", providers, detectAll, listModels };
}
