#!/usr/bin/env node
/* ============================================================================
 * bridge.mjs — 로컬 진입점 (Node 18+)
 *
 * 역할: 콘솔 HTML 을 same-origin 으로 서빙하고, API 요청을 server-core 로 위임한다.
 *       백엔드(cli/api)와 저장소(local/s3)는 env 로 갈아끼운다 — 코어/계약은 그대로.
 *
 * 실행:  node bridge.mjs                         → http://127.0.0.1:8787, 로컬 CLI + 디스크
 *        PORT=9000 node bridge.mjs               → 포트 변경
 *        BACKEND=api OPENAI_API_KEY=… node bridge.mjs   → OpenAI API 백엔드(로컬 테스트)
 *        STORAGE=s3 S3_BUCKET=… node bridge.mjs   → 생성 파일을 S3 로(로컬 AWS 자격증명)
 *
 * 보안: 127.0.0.1 에만 바인딩(외부 미노출). 루프백 origin 만 허용(drive-by/로컬 SSRF 차단).
 *       로컬 모드는 인증 없음(requireAuth=false) — 공개 배포는 lambda.mjs(어드민 API 인증).
 * ========================================================================== */

import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createCore } from "./server-core.mjs";
import { createStorage } from "./storage/index.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT) || 8787;
const MAX_BODY = 4 * 1024 * 1024;
const HTML_FILE = "content-maker.html";
const __dir = dirname(fileURLToPath(import.meta.url));
const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate", "Pragma": "no-cache", "Expires": "0" };

// 루프백(로컬) origin 만 허용. Origin 헤더가 없으면(동일 origin GET·curl·로컬 도구) 허용.
function originAllowed(origin) {
  if (!origin) return true;
  try { const h = new URL(origin).hostname; return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]"; }
  catch (_) { return false; }
}
function setCors(req, res) {
  const origin = req.headers.origin;
  if (originAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error("요청 본문이 너무 큽니다.")); req.destroy(); return; } chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function makeBackend() {
  const kind = String(process.env.BACKEND || "cli").toLowerCase();
  if (kind === "api") { const { makeApiBackend } = await import("./backends/api/index.mjs"); return makeApiBackend(process.env); }
  const { makeCliBackend } = await import("./backends/cli/index.mjs"); return makeCliBackend(process.env);
}

const backend = await makeBackend();
const storage = await createStorage(process.env);
const core = createCore({ backend, storage, verifyToken: async () => ({ ok: true, userId: null }), originAllowed, requireAuth: false });

// 로컬 개발 편의: 서버 모드 로그인(/auth/**)을 파마브로스 어드민 API 로 프록시(프로덕션은 Cloudflare functions/auth 담당).
const PHARMACY_API_BASE = process.env.PHARMACY_API_BASE || "https://api.store.friendly-pharmacist.com";
async function proxyAuth(req, res, url, body) {
  const target = PHARMACY_API_BASE + url.pathname.slice("/auth".length) + url.search;
  const headers = {};
  for (const k of Object.keys(req.headers)) {
    const lk = k.toLowerCase();
    if (lk === "host" || lk === "origin" || lk === "referer" || lk === "content-length" || lk === "connection") continue;
    headers[k] = req.headers[k];
  }
  try {
    const r = await fetch(target, { method: req.method, headers, body: (req.method === "GET" || req.method === "HEAD") ? undefined : body });
    const buf = Buffer.from(await r.arrayBuffer());
    const h = { ...NO_CACHE };
    const ct = r.headers.get("content-type"); if (ct) h["Content-Type"] = ct;
    res.writeHead(r.status, h);
    res.end(buf);
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json; charset=utf-8", ...NO_CACHE });
    res.end(JSON.stringify({ ok: false, error: "어드민 API 프록시 실패: " + (e && e.message || e) }));
  }
}

const server = http.createServer(async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const path = url.pathname;

  // 콘솔 HTML 서빙(same-origin) — 로컬 진입점 전용
  if (req.method === "GET" && (path === "/" || path === "/" + HTML_FILE)) {
    try {
      const html = await readFile(join(__dir, HTML_FILE));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...NO_CACHE });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("HTML 파일을 찾을 수 없습니다: " + HTML_FILE);
    }
    return;
  }

  let body = "";
  if (req.method === "POST" || req.method === "PUT" || req.method === "DELETE") {
    try { body = await readBody(req); }
    catch (e) { res.writeHead(413, { "Content-Type": "application/json; charset=utf-8", ...NO_CACHE }); res.end(JSON.stringify({ ok: false, error: e.message })); return; }
  }
  // 로컬 개발: 서버 모드 로그인(/auth/**) → 파마브로스 어드민 API 프록시(Cloudflare functions/auth 대체).
  if (path === "/auth" || path.startsWith("/auth/")) { await proxyAuth(req, res, url, body); return; }

  const headers = {}; for (const k of Object.keys(req.headers)) headers[k.toLowerCase()] = req.headers[k];
  const reqN = { method: req.method, path, query: url.searchParams, headers, body, origin: req.headers.origin };

  let resp;
  try { resp = await core.handle(reqN); }
  catch (e) { resp = { status: 500, json: { ok: false, error: "서버 오류: " + (e && e.message || e) } }; }

  if (resp.json !== undefined) { res.writeHead(resp.status, { "Content-Type": "application/json; charset=utf-8", ...NO_CACHE }); res.end(JSON.stringify(resp.json)); return; }
  if (resp.body !== undefined) { res.writeHead(resp.status, { "Content-Type": resp.contentType || "application/octet-stream", ...NO_CACHE }); res.end(resp.body); return; }
  res.writeHead(resp.status || 204); res.end();
});

server.listen(PORT, HOST, async () => {
  let detected = {};
  try { detected = backend.detectAll ? await backend.detectAll() : {}; } catch (_) {}
  const found = Object.keys(detected).filter((k) => detected[k]);
  const missing = Object.keys(detected).filter((k) => !detected[k]);
  console.log("──────────────────────────────────────────────");
  console.log(" 콘텐츠 파이프라인 브리지 실행 중");
  console.log("   주소     : http://" + HOST + ":" + PORT + "   ← 브라우저로 여세요");
  console.log("   백엔드   : " + backend.kind + "   저장소 : " + storage.kind);
  if (found.length || missing.length) {
    if (found.length) console.log("   감지됨   : " + found.join(", "));
    if (missing.length) console.log("   미감지   : " + missing.join(", ") + "  (설치/PATH 확인)");
  }
  if (storage.outputDir) console.log("   저장 폴더: " + storage.outputDir);
  console.log("   종료: Ctrl+C");
  console.log("──────────────────────────────────────────────");
});
