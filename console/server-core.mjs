/* ============================================================================
 * server-core.mjs — 백엔드/스토리지 무관 라우팅·검증 (bridge.mjs / lambda.mjs 공용)
 *
 * 진입점(bridge=node http, lambda=event)이 요청을 '정규화된 req' 로 바꿔 handle() 에 넘기고,
 * handle() 은 '정규화된 응답'을 돌려준다 → 진입점이 각자 형식으로 변환한다.
 *
 *   req  = { method, path, query(URLSearchParams), headers(소문자키 obj), body(string), origin }
 *   resp = { status, json } | { status, body(Buffer|string), contentType } | { status:204, cors:true }
 *
 * 하나의 HTTP 계약(/run /image /video /health /models /jobs /output), 두 백엔드(cli/api), 두 저장소(local/s3).
 * 인증은 주입된 verifyToken(token)→{ok,userId} seam 으로만(계약을 코어에 박지 않음).
 * ========================================================================== */

import { extname } from "node:path";
import { MEDIA_EXTS } from "./util.mjs";

function san(s, max) { return String(s == null ? "" : s).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, max || 64); }
function bearer(h) { const m = /^Bearer\s+(.+)$/i.exec(String(h || "").trim()); return m ? m[1].trim() : ""; }
function nowIso() { return new Date().toISOString(); }
function genId() { return "job-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7); }

/* opts:
 *   backend   : { kind, providers:{id->provider}, detectAll?(), listModels?() }
 *   storage   : { save, urlFor, putJson, getJson, list, del, readMedia? }
 *   verifyToken(token) -> { ok, userId }   (requireAuth 일 때만 호출)
 *   originAllowed(origin) -> bool
 *   requireAuth : bool (로컬=false, lambda=true)
 */
export function createCore(opts) {
  const { backend, storage, verifyToken, originAllowed, requireAuth } = opts;
  const J = (status, json) => ({ status, json });

  // 작업 JSON 안의 미디어 key 를 '읽을 때' fresh url 로 채운다(presigned 만료 방지).
  async function resolveMediaUrls(state) {
    if (!state || typeof state !== "object") return;
    for (const g of ["imageGen", "videoGen"]) {
      const items = state[g] && Array.isArray(state[g].items) ? state[g].items : null;
      if (!items) continue;
      for (const it of items) { if (it && it.key) { try { it.url = await storage.urlFor(it.key); } catch (_) {} } }
    }
  }
  const metaOf = (j) => ({ id: j.id, title: j.title, platform: j.platform, createdAt: j.createdAt, updatedAt: j.updatedAt });

  async function health() {
    const providers = backend.detectAll ? await backend.detectAll() : {};
    const capabilities = {};
    for (const [id, p] of Object.entries(backend.providers)) capabilities[id] = p.capabilities;
    return J(200, { ok: true, backend: backend.kind, storage: storage.kind, providers, capabilities });
  }
  async function models() {
    try { return J(200, { ok: true, backend: backend.kind, providers: backend.listModels ? await backend.listModels() : {} }); }
    catch (e) { return J(200, { ok: false, error: "모델 목록 조회 실패: " + (e && e.message || e) }); }
  }

  function parseBody(req) { try { return JSON.parse(req.body || "{}"); } catch (e) { return null; } }

  async function run(req) {
    const p = parseBody(req); if (!p) return J(400, { ok: false, error: "잘못된 요청 본문(JSON 파싱 실패)" });
    const provider = backend.providers[p.provider];
    if (!provider) return J(400, { ok: false, error: "알 수 없는 provider: " + p.provider });
    if (!provider.runText) return J(200, { ok: false, disabled: true, error: provider.id + " 는 텍스트 생성을 지원하지 않습니다." });
    const prompt = String(p.prompt || "");
    if (!prompt.trim()) return J(400, { ok: false, error: "prompt 가 비어 있습니다." });
    const result = await provider.runText({ model: (p.model || "").toString().trim(), prompt });
    return J(200, result);   // 실패도 200 + {ok:false} (콘솔이 메시지 표시)
  }

  async function image(req) {
    const p = parseBody(req); if (!p) return J(400, { ok: false, error: "잘못된 요청 본문(JSON 파싱 실패)" });
    const provider = backend.providers[p.provider] || backend.providers.agy || backend.providers.openai;
    if (!provider) return J(400, { ok: false, error: "이미지 provider 를 찾을 수 없습니다." });
    if (!provider.runImage) return J(200, { ok: false, disabled: true, error: provider.id + " 는 이미지 생성을 지원하지 않습니다." });
    const prompt = String(p.prompt || "");
    if (!prompt.trim()) return J(400, { ok: false, error: "prompt 가 비어 있습니다." });
    const runId = san(p.runId || "run", 40) || "run";
    const idx = san(p.idx != null ? p.idx : 0, 12) || "0";
    const gen = await provider.runImage({ prompt, model: (p.model || "").toString().trim() });
    if (!gen.ok) return J(200, gen);
    try {
      const saved = await storage.save(`${runId}/${idx}.${gen.ext}`, gen.buf, gen.mime);
      return J(200, { ok: true, url: saved.url, key: saved.key, path: saved.key, mime: gen.mime, bytes: gen.buf.length });
    } catch (e) { return J(200, { ok: false, error: "이미지 저장 실패: " + (e && e.message || e) }); }
  }

  async function video(req) {
    const p = parseBody(req); if (!p) return J(400, { ok: false, error: "잘못된 요청 본문(JSON 파싱 실패)" });
    const provider = backend.providers[p.provider];
    if (!provider) return J(400, { ok: false, error: "알 수 없는 provider: " + p.provider });
    if (!provider.runVideo) return J(200, { ok: false, disabled: true, error: "이 백엔드/모델은 영상 제작을 지원하지 않습니다. 로컬 모드(codex/claude)에서 제작하세요." });
    const imagePrompt = String(p.imagePrompt || ""), motionPrompt = String(p.motionPrompt || "");
    if (!imagePrompt.trim() && !motionPrompt.trim()) return J(400, { ok: false, error: "이미지 프롬프트와 모션 프롬프트가 모두 비어 있습니다." });
    const runId = san(p.runId || "run", 40) || "run";
    const idx = san(p.idx != null ? p.idx : 0, 12) || "0";
    const r = await provider.runVideo({
      engine: p.engine, imagePrompt, motionPrompt,
      videoModel: p.videoModel, imageModel: p.imageModel, aspect: p.aspect, duration: p.duration, model: p.model,
    });
    if (!r.ok) return J(200, r);
    let url = null, key = null, bytes = null, saveError = r.saveError || null;
    if (r.buf) {
      try { const s = await storage.save(`${runId}/${idx}${r.ext || ".mp4"}`, r.buf, r.mime); url = s.url; key = s.key; bytes = r.buf.length; }
      catch (e) { saveError = e && e.message || String(e); }
    }
    return J(200, {
      ok: true, videoUrl: r.videoUrl, url, key, path: key, bytes, saveError,
      imageUrl: r.imageUrl || null, imageJobId: r.imageJobId || null, videoJobId: r.videoJobId || null,
    });
  }

  /* ---- 작업(Job) 영속화: GET 목록 · GET 상세 · PUT/POST 저장 · DELETE ---- */
  async function jobs(req, auth) {
    const prefix = (requireAuth && auth && auth.userId) ? `jobs/${san(auth.userId)}/` : "jobs/";
    const m = /^\/jobs\/(.+)$/.exec(req.path);
    const id = m ? san(m[1]) : null;

    if (req.method === "GET" && !id) {
      const entries = await storage.list(prefix);
      const metas = [];
      for (const e of entries) {
        if (!e.key.endsWith(".json")) continue;
        const j = await storage.getJson(e.key);
        if (j && j.id) metas.push(metaOf(j));
      }
      metas.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
      return J(200, { ok: true, jobs: metas });
    }
    if (req.method === "GET" && id) {
      const j = await storage.getJson(prefix + id + ".json");
      if (!j) return J(404, { ok: false, error: "작업을 찾을 수 없습니다." });
      await resolveMediaUrls(j.state);
      return J(200, { ok: true, job: j });
    }
    if (req.method === "PUT" || req.method === "POST") {
      const body = parseBody(req); if (!body) return J(400, { ok: false, error: "잘못된 요청 본문(JSON 파싱 실패)" });
      const jid = id || san(body.id) || genId();
      const existing = await storage.getJson(prefix + jid + ".json");
      const now = nowIso();
      const job = {
        id: jid,
        title: (String(body.title || "").trim().slice(0, 200)) || (existing && existing.title) || "제목 없음",
        platform: body.platform || (existing && existing.platform) || "",
        createdAt: (existing && existing.createdAt) || now,
        updatedAt: now,
        state: (body.state && typeof body.state === "object") ? body.state : (existing && existing.state) || {},
      };
      await storage.putJson(prefix + jid + ".json", job);
      return J(200, { ok: true, id: jid, createdAt: job.createdAt, updatedAt: now });
    }
    if (req.method === "DELETE" && id) { await storage.del(prefix + id + ".json"); return J(200, { ok: true }); }
    return J(405, { ok: false, error: "허용되지 않은 메서드" });
  }

  // 로컬 미디어 정적 서빙(<img>/<video> src). s3 백엔드는 readMedia 없음 → 404(미디어는 presigned 직접).
  async function serveOutput(req) {
    if (typeof storage.readMedia !== "function") return { status: 404, body: "not found", contentType: "text/plain; charset=utf-8" };
    let rel; try { rel = decodeURIComponent(req.path.slice("/output/".length)); } catch (e) { return { status: 400, body: "bad path", contentType: "text/plain" }; }
    const ext = extname(rel).toLowerCase();
    if (!MEDIA_EXTS.has(ext)) return { status: 403, body: "forbidden", contentType: "text/plain; charset=utf-8" };
    try { const md = await storage.readMedia(rel); return { status: 200, body: md.buf, contentType: md.mime }; }
    catch (e) { return { status: 404, body: "not found", contentType: "text/plain; charset=utf-8" }; }
  }

  async function handle(req) {
    if (req.method === "OPTIONS") return { status: 204, cors: true };

    // 미디어 서빙은 origin/auth 가드 없음(이미지 로드 위해) — 기존 동작과 동일. key 는 추측 어려운 runId 라 capability URL.
    if (req.method === "GET" && req.path.startsWith("/output/")) return serveOutput(req);

    if (!originAllowed(req.origin)) return J(403, { ok: false, error: "허용되지 않은 출처입니다." });

    let auth = { ok: true, userId: null };
    if (requireAuth) {
      auth = await verifyToken(bearer(req.headers["authorization"]));
      if (!auth || !auth.ok) return J(401, { ok: false, error: "인증이 필요합니다." });
    }

    if (req.method === "GET" && req.path === "/health") return health();
    if (req.method === "GET" && req.path === "/models") return models();
    if (req.method === "POST" && req.path === "/run") return run(req);
    if (req.method === "POST" && req.path === "/image") return image(req);
    if (req.method === "POST" && req.path === "/video") return video(req);
    if (req.path === "/jobs" || req.path.startsWith("/jobs/")) return jobs(req, auth);

    return J(404, { ok: false, error: "Not found" });
  }

  return { handle };
}
