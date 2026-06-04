/**
 * Cloudflare Pages Functions — Auth Proxy (pharmabros-settlement 참조)
 * /auth/** → https://api.store.friendly-pharmacist.com/**
 *
 * 콘솔(서버 모드)의 로그인/2FA 요청을 same-origin 으로 받아 파마브로스 어드민 API 로 포워딩한다.
 * 이 프록시가 없으면 서버 모드 로그인이 404 가 된다(content-maker Pages 배포에 필수).
 *
 * 백엔드(/run·/image·/jobs 등 → Lambda)는 별도 프록시(functions/[[path]] 또는 /api 라우팅)에서 처리.
 */

const PHARMACY_API_BASE = 'https://api.store.friendly-pharmacist.com';

// content-maker Pages 배포 도메인을 여기에 추가(배포 후 실제 도메인으로 갱신).
const ALLOWED_ORIGINS = [
  'http://localhost:8788',
  'http://127.0.0.1:8788',
];

function corsOrigin(request) {
  const origin = request.headers.get('origin') || '';
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  if (origin.endsWith('.pages.dev')) return origin;   // Cloudflare Pages 프리뷰/프로덕션
  return ALLOWED_ORIGINS[0];
}
function corsHeaders(request) {
  return {
    'Access-Control-Allow-Origin': corsOrigin(request),
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

export async function onRequest(context) {
  const { request } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  const url = new URL(request.url);
  // /auth/api/admin/... → https://api.store.friendly-pharmacist.com/api/admin/...
  const targetPath = url.pathname.slice('/auth'.length) + url.search;
  const targetUrl = `${PHARMACY_API_BASE}${targetPath}`;

  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('origin');
  headers.delete('referer');

  const init = { method: request.method, headers };
  if (!['GET', 'HEAD'].includes(request.method)) {
    init.body = request.body;
    init.duplex = 'half';
  }

  const res = await fetch(targetUrl, init);

  const responseHeaders = new Headers(res.headers);
  Object.entries(corsHeaders(request)).forEach(([k, v]) => responseHeaders.set(k, v));

  return new Response(res.body, { status: res.status, headers: responseHeaders });
}
