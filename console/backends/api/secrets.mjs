/* ============================================================================
 * backends/api/secrets.mjs — provider API 키 저장소 로더
 *
 *   SECRETS_ID 가 있으면 AWS Secrets Manager 에서 시크릿(JSON)을 콜드스타트 1회 로드·캐시.
 *   없으면(로컬/테스트) process.env 에서 키를 읽는다(fallback).
 *   env 키는 시크릿 위에 덮어쓴다(로컬 디버그 편의).
 *
 * 반환: { OPENAI_API_KEY?, ANTHROPIC_API_KEY?, GEMINI_API_KEY?, ... }
 *
 * @aws-sdk/client-secrets-manager 는 SECRETS_ID 가 있을 때만 동적 import → 로컬 env 모드는 SDK 미로드.
 * ========================================================================== */

const KNOWN_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"];
let cached = null;   // 모듈 레벨 캐시(Lambda 컨테이너 재사용 시 유지)

export async function loadSecrets(env) {
  env = env || process.env;
  if (cached) return cached;

  const fromEnv = {};
  for (const k of KNOWN_KEYS) if (env[k]) fromEnv[k] = env[k];

  if (env.SECRETS_ID) {
    try {
      const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
      const region = env.S3_REGION || env.AWS_REGION || undefined;
      const client = new SecretsManagerClient(region ? { region } : {});
      const r = await client.send(new GetSecretValueCommand({ SecretId: env.SECRETS_ID }));
      const parsed = r.SecretString ? JSON.parse(r.SecretString) : {};
      cached = { ...parsed, ...fromEnv };   // env 가 우선
      return cached;
    } catch (e) {
      console.error("[secrets] Secrets Manager 로드 실패 — env fallback 으로 진행:", (e && e.message) || e);
    }
  }
  cached = fromEnv;
  return cached;
}

// 테스트/핫스왑용
export function _resetSecretsCache() { cached = null; }
