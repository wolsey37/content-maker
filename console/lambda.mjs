/* ============================================================================
 * lambda.mjs — AWS Lambda Function URL 진입점 (서버/API 모드)
 *
 *   Cloudflare Pages 정적 HTML → (fetch + Bearer 토큰) → 이 Lambda → server-core → api 백엔드.
 *   저장소는 S3(무상태), 키는 Secrets Manager, 인증은 기존 어드민 API.
 *
 *   Function URL(payload v2.0) 권장 — API Gateway 29초 제한 없이 이미지 생성(수십 초)을 동기 처리.
 *
 * 필수 env: SECRETS_ID, S3_BUCKET, ADMIN_VERIFY_URL, ALLOWED_ORIGINS
 *           STORAGE 는 미설정 시 s3 로 강제(무상태).
 * ========================================================================== */

import { createCore } from "./server-core.mjs";
import { createStorage } from "./storage/index.mjs";
import { makeApiBackend } from "./backends/api/index.mjs";
import { loadSecrets } from "./backends/api/secrets.mjs";
import { verifyJwtHS256, subjectOf } from "./backends/api/jwt.mjs";

const ALLOWED = String(process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
function originAllowed(origin) {
  if (!origin) return true;                 // 동일 origin/서버 간/도구(브라우저 아님)
  if (ALLOWED.includes("*")) return true;
  return ALLOWED.includes(origin);
}
function corsHeaders(origin) {
  if (!originAllowed(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "600",
  };
}

/* 토큰 검증 — 파마브로스 어드민 API 가 발급한 JWT 를 'prod/store' 시크릿의 jwt-secret 으로 로컬 서명 검증.
 *   알고리즘은 HS256 으로 고정(토큰 alg 헤더 불신, none/기타 거부). 발급은 우리가 하지 않는다.
 *   ※ 실제 alg 가 HS256 이 아니면(예: RS256) jwt.mjs 검증기를 그에 맞게 확장해야 한다. */
async function verifyToken(token) {
  if (!token) return { ok: false };
  const secrets = await loadSecrets(process.env);
  const secret = secrets["jwt-secret"] || secrets.JWT_SECRET;
  if (!secret) return { ok: false };
  const r = verifyJwtHS256(token, secret);
  if (!r.ok) return { ok: false };
  const p = r.payload || {};
  // 공유 시크릿(prod/store 등) 방어(선택): JWT_EXPECTED_AUD/ISS 설정 시 다른 서비스용 토큰 거부.
  // 파마브로스 백엔드(main.py)는 서명+exp 만 검사하므로 기본(env 미설정)은 동일 동작.
  const expAud = process.env.JWT_EXPECTED_AUD, expIss = process.env.JWT_EXPECTED_ISS;
  if (expAud) { const a = p.aud; if (!(Array.isArray(a) ? a.includes(expAud) : a === expAud)) return { ok: false }; }
  if (expIss && p.iss !== expIss) return { ok: false };
  return { ok: true, userId: subjectOf(p) };
}

// 콜드스타트 1회 조립(컨테이너 재사용 시 캐시) — Secrets/SDK 클라이언트 재활용.
let coreP = null;
function getCore() {
  if (coreP) return coreP;
  coreP = (async () => {
    const backend = await makeApiBackend(process.env);
    const storage = await createStorage({ ...process.env, STORAGE: process.env.STORAGE || "s3" });
    return createCore({ backend, storage, verifyToken, originAllowed, requireAuth: true });
  })();
  return coreP;
}

export const handler = async (event) => {
  const core = await getCore();
  const httpCtx = (event.requestContext && event.requestContext.http) || {};
  const method = httpCtx.method || event.httpMethod || "GET";
  const path = event.rawPath || event.path || "/";
  const headers = {};
  for (const k of Object.keys(event.headers || {})) headers[k.toLowerCase()] = event.headers[k];
  const origin = headers["origin"];
  const query = new URLSearchParams(event.rawQueryString || "");
  let body = event.body || "";
  if (event.isBase64Encoded && body) body = Buffer.from(body, "base64").toString("utf8");

  const cors = corsHeaders(origin);
  if (method === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };

  let resp;
  try { resp = await core.handle({ method, path, query, headers, body, origin }); }
  catch (e) { resp = { status: 500, json: { ok: false, error: "서버 오류: " + (e && e.message || e) } }; }

  const noCache = { "Cache-Control": "no-store" };
  if (resp.json !== undefined) {
    return { statusCode: resp.status, headers: { "Content-Type": "application/json; charset=utf-8", ...noCache, ...cors }, body: JSON.stringify(resp.json) };
  }
  if (resp.body !== undefined) {
    const isBuf = Buffer.isBuffer(resp.body);
    return { statusCode: resp.status, headers: { "Content-Type": resp.contentType || "application/octet-stream", ...noCache, ...cors }, body: isBuf ? resp.body.toString("base64") : resp.body, isBase64Encoded: isBuf };
  }
  return { statusCode: resp.status || 204, headers: cors, body: "" };
};
