/* ============================================================================
 * backends/api/jwt.mjs — JWT(HS256) 로컬 검증 (서버/Lambda 인증용)
 *
 * 토큰은 파마브로스 어드민 API 가 발급하고, 우리는 JWT_SECRET_ID(기본 'prod/connect') 시크릿의
 * jwt-secret 으로 서명을 검증만 한다(발급하지 않음). node:crypto 만 사용(로컬 모드는 이 모듈을 import 하지 않음).
 *
 * 보안(중요):
 *  - 알고리즘을 서버에서 HS256 으로 '고정'한다. 토큰 헤더의 alg 를 신뢰하지 않으며,
 *    alg:"none" 또는 HS256 이외(RS256/HS512 등)는 즉시 거부 → classic JWT alg-confusion 우회 차단.
 *  - 서명 비교는 timingSafeEqual(상수시간), base64url 정확 처리, exp/nbf 검사.
 * ========================================================================== */

import { createHmac, timingSafeEqual } from "node:crypto";

function b64urlToBuf(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}
function b64urlJson(s) { return JSON.parse(b64urlToBuf(s).toString("utf8")); }

// token 을 secret(HS256)으로 검증 → { ok, payload } 또는 { ok:false, error }
export function verifyJwtHS256(token, secret) {
  if (!token || typeof token !== "string") return { ok: false, error: "토큰이 없습니다." };
  if (!secret) return { ok: false, error: "jwt-secret 이 설정되지 않았습니다." };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, error: "JWT 형식이 아닙니다." };
  const [h, p, sig] = parts;

  let header, payload;
  try { header = b64urlJson(h); } catch (e) { return { ok: false, error: "헤더 디코드 실패" }; }
  try { payload = b64urlJson(p); } catch (e) { return { ok: false, error: "페이로드 디코드 실패" }; }

  // 알고리즘 고정 — 토큰이 주장하는 alg 를 신뢰하지 않는다.
  if (!header || header.alg !== "HS256") return { ok: false, error: "허용되지 않은 alg: " + (header && header.alg) };

  const expected = createHmac("sha256", secret).update(h + "." + p).digest();
  let given;
  try { given = b64urlToBuf(sig); } catch (e) { return { ok: false, error: "서명 디코드 실패" }; }
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, error: "서명이 일치하지 않습니다." };

  const now = Math.floor(Date.now() / 1000);
  // exp 필수 — 없으면 영구 유효 토큰이 되므로 거부(클라이언트 isJwtExpired 와 동일 기준. 파마브로스 발급 토큰은 항상 exp 포함).
  if (typeof payload.exp !== "number") return { ok: false, error: "만료 시각(exp)이 없는 토큰은 거부합니다." };
  if (payload.exp <= now) return { ok: false, error: "토큰이 만료되었습니다." };
  if (typeof payload.nbf === "number" && payload.nbf > now) return { ok: false, error: "아직 유효하지 않은 토큰입니다." };

  return { ok: true, payload };
}

// 페이로드에서 사용자 식별자 추출(작업 per-user prefix 용).
// 파마브로스/일반 JWT 필드명이 환경마다 다를 수 있어 흔한 계정 필드를 넓게 수용한다.
export function subjectOf(payload) {
  if (!payload || typeof payload !== "object") return null;
  const keys = [
    "admin_idx", "adminIdx",
    "adminId", "admin_id", "adminEmail", "email",
    "userId", "user_id", "accountId", "account_id",
    "sub", "id", "idx",
  ];
  for (const k of keys) {
    const v = payload[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return null;
}
