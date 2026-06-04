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
let cached = null;          // provider 키 캐시(SECRETS_ID)
let jwtSecretCache = null;  // JWT 검증용 jwt-secret 캐시(JWT_SECRET_ID, 기본 prod/connect — provider 키와 별개 시크릿)

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

// JWT 검증용 jwt-secret 로드 — pharmabros lambda/backend/main.py 와 동일 규약.
//   JWT_SECRET_ID(기본 'prod/connect') 시크릿의 'jwt-secret' 키. 로컬/테스트는 env JWT_SECRET fallback.
//   ※ 파마브로스 어드민 API 가 토큰 서명에 쓰는 secret 과 동일해야 검증 통과(같은 시크릿 prod/connect).
export async function loadJwtSecret(env) {
  env = env || process.env;
  if (jwtSecretCache) return jwtSecretCache;
  if (env.JWT_SECRET) { jwtSecretCache = env.JWT_SECRET; return jwtSecretCache; }
  const id = env.JWT_SECRET_ID || "prod/connect";
  try {
    const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
    const region = env.JWT_SECRET_REGION || env.S3_REGION || env.AWS_REGION || "ap-northeast-2";
    const client = new SecretsManagerClient({ region });
    const r = await client.send(new GetSecretValueCommand({ SecretId: id }));
    const val = r.SecretString || "";
    try { jwtSecretCache = JSON.parse(val)["jwt-secret"] || val; } catch { jwtSecretCache = val; }
    return jwtSecretCache;
  } catch (e) {
    console.error("[jwt-secret] 로드 실패(" + id + "): " + ((e && e.message) || e));
    return null;
  }
}

// 테스트/핫스왑용
export function _resetSecretsCache() { cached = null; jwtSecretCache = null; }
