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
import { loadSecrets, loadJwtSecret } from "./backends/api/secrets.mjs";
import { verifyJwtHS256, subjectOf } from "./backends/api/jwt.mjs";

const ALLOWED = String(process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
function isLoopbackOrigin(origin) {
  try {
    const u = new URL(origin);
    return (u.protocol === "http:" || u.protocol === "https:") &&
      (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1" || u.hostname === "[::1]");
  } catch (_) {
    return false;
  }
}
function originAllowed(origin) {
  if (!origin) return true;                 // 동일 origin/서버 간/도구(브라우저 아님)
  if (isLoopbackOrigin(origin)) return true; // 로컬에서 ?mode=server 로 Lambda 직접 테스트
  if (ALLOWED.includes("*")) return true;
  return ALLOWED.includes(origin);
}
function corsHeaders(origin) {
  if (!originAllowed(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Id",
    "Access-Control-Max-Age": "600",
  };
}

/* 토큰 검증 — 파마브로스 어드민 API 가 발급한 JWT 를 JWT_SECRET_ID(기본 'prod/connect') 시크릿의
 *   jwt-secret 으로 HS256 로컬 서명 검증(토큰 alg 헤더 불신, none/기타 거부). 발급은 우리가 하지 않는다.
 *   ※ pharmabros lambda/backend/main.py 와 동일 시크릿/규약. */
async function verifyToken(token) {
  if (!token) return { ok: false };
  const secret = await loadJwtSecret(process.env);
  if (!secret) return { ok: false };
  const r = verifyJwtHS256(token, secret);
  if (!r.ok) return { ok: false };
  const p = r.payload || {};
  // 공유 시크릿(prod/connect) 방어(선택): JWT_EXPECTED_AUD/ISS 설정 시 다른 서비스용 토큰 거부.
  // 파마브로스 백엔드(main.py)는 서명+exp 만 검사하므로 기본(env 미설정)은 동일 동작.
  const expAud = process.env.JWT_EXPECTED_AUD, expIss = process.env.JWT_EXPECTED_ISS;
  if (expAud) { const a = p.aud; if (!(Array.isArray(a) ? a.includes(expAud) : a === expAud)) return { ok: false }; }
  if (expIss && p.iss !== expIss) return { ok: false };
  // master 전용 — 다른 역할(operator/seller 등)은 서명이 유효해도 거부. 사유를 내려 '조용한 401'(LLM 연동 장애처럼 보임)을 방지.
  // 문구의 앱 명칭은 로그인 화면 제목(콘텐츠 스튜디오)과 일치시킨다.
  if (p.admin_role_cd !== "master") return { ok: false, error: "콘텐츠 스튜디오는 master 권한 계정만 이용할 수 있습니다. (현재 계정 권한: " + (p.admin_role_cd || "없음") + ")" };
  const userId = subjectOf(p);
  if (!userId) return { ok: false, error: "토큰에서 계정 식별자를 찾을 수 없습니다." };
  return { ok: true, userId };
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
