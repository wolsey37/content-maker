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
import { MEDIA_EXTS, detectImage } from "./util.mjs";

// 사용자 업로드 사진·합성 카드(PNG) 1장의 디코드 후 최대 바이트(과대 페이로드 방어). 클라가 다운스케일해 보내므로 넉넉히.
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES) || 10 * 1024 * 1024;
// data URL("data:image/...;base64,XXXX") 또는 순수 base64 → Buffer. 형식은 매직바이트로 따로 검증.
function decodeDataImage(s) {
  let b64 = String(s || "");
  const m = /^data:[^,]*,(.*)$/s.exec(b64);
  if (m) b64 = m[1];
  if (!b64.trim()) return null;
  let buf; try { buf = Buffer.from(b64, "base64"); } catch (_) { return null; }
  return (buf && buf.length) ? buf : null;
}

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
    // 약국 소개 빌더의 업로드 사진도 fresh url 로 갱신(재방문 시 presigned 만료로 재합성이 깨지지 않게).
    const photos = state.pharmacy && Array.isArray(state.pharmacy.photos) ? state.pharmacy.photos : null;
    if (photos) { for (const p of photos) { if (p && p.key) { try { p.url = await storage.urlFor(p.key); } catch (_) {} } } }
  }
  // 작업의 '목록용 경량 메타'(presign 없이) — 인덱스 저장·목록 표시에 공용. 전체 state 를 안 담아 작고 빠르다.
  function metaOfRaw(j) {
    const meta = { id: j.id, title: j.title, platform: j.platform, createdAt: j.createdAt, updatedAt: j.updatedAt };
    const imgItems = j.state && j.state.imageGen && Array.isArray(j.state.imageGen.items) ? j.state.imageGen.items : [];
    const vidItems = j.state && j.state.videoGen && Array.isArray(j.state.videoGen.items) ? j.state.videoGen.items : [];
    const firstImg = imgItems.find((it) => it && (it.key || it.url));   // 실패/진행중 슬롯(key·url 없음)은 건너뛰고 완료분을 썸네일로
    const firstVid = vidItems.find((it) => it && (it.imageUrl || it.url || it.key));
    const thumb = firstImg || firstVid || null;
    if (thumb) {
      meta.thumbnailKey = thumb.key || null;
      meta.thumbnailUrl = thumb.key ? null : (thumb.imageUrl || thumb.url || null);   // key 있으면 읽을 때 presign, 없으면(로컬) 안정 URL 그대로
    }
    return meta;
  }
  // 표시 직전 thumbnailKey 를 fresh presigned URL 로 채운다(presign 만료 방지).
  async function withThumbUrl(meta) {
    if (meta && meta.thumbnailKey) { try { meta.thumbnailUrl = await storage.urlFor(meta.thumbnailKey); } catch (_) {} }
    return meta;
  }
  // 서버 모드(인증)에서 모든 S3 객체(미디어·작업)를 prod/<계정>/ 아래로 격리한다.
  // 로컬 모드는 userId 가 없으므로 "" → 기존 output/ 경로(회귀 없음).
  // 약국 소개 카드뉴스(공개·무로그인)는 전용 폴더 pharmacy/ 아래로 별도 관리(계정 무관).
  const userPrefix = (auth) => (auth && auth.pharmacy) ? "pharmacy/" : ((auth && auth.userId) ? ("prod/" + (san(auth.userId) || "unknown") + "/") : "");

  // 작업 state 에 의미 있는 내용(주제·단계 출력·생성 미디어)이 있는지 — 빈 작업 저장 거부용(클라이언트 jobHasContent 와 동일 기준).
  function stateHasContent(state) {
    if (!state || typeof state !== "object") return false;
    if (String(state.topic || "").trim()) return true;
    const steps = state.steps && typeof state.steps === "object" ? state.steps : {};
    for (const k of Object.keys(steps)) { if (steps[k] && String(steps[k].output || "").trim()) return true; }
    const ig = state.imageGen && Array.isArray(state.imageGen.items) ? state.imageGen.items : [];
    const vg = state.videoGen && Array.isArray(state.videoGen.items) ? state.videoGen.items : [];
    if (ig.some(Boolean) || vg.some(Boolean)) return true;
    return false;
  }
  function mergeMediaPlaceholders(next, prev) {
    if (!next || !prev || typeof next !== "object" || typeof prev !== "object") return next;
    for (const g of ["imageGen", "videoGen"]) {
      const ni = next[g] && Array.isArray(next[g].items) ? next[g].items : null;
      const pi = prev[g] && Array.isArray(prev[g].items) ? prev[g].items : null;
      if (!ni || !pi || !pi.some(Boolean)) continue;
      for (let i = 0; i < ni.length; i++) {
        if (!ni[i] && pi[i]) ni[i] = pi[i];
      }
    }
    return next;
  }

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

  async function image(req, auth) {
    const p = parseBody(req); if (!p) return J(400, { ok: false, error: "잘못된 요청 본문(JSON 파싱 실패)" });
    const provider = backend.providers[p.provider] || backend.providers.agy || backend.providers.openai;
    if (!provider) return J(400, { ok: false, error: "이미지 provider 를 찾을 수 없습니다." });
    if (!provider.runImage) return J(200, { ok: false, disabled: true, error: provider.id + " 는 이미지 생성을 지원하지 않습니다." });
    const prompt = String(p.prompt || "");
    if (!prompt.trim()) return J(400, { ok: false, error: "prompt 가 비어 있습니다." });
    const runId = san(p.runId || "run", 40) || "run";
    const idx = san(p.idx != null ? p.idx : 0, 12) || "0";
    const kind = san(p.kind || "misc", 24) || "misc";   // 콘텐츠 유형(card/feed/story/reels 등)
    const jobId = san(p.jobId || "", 60);
    const base = jobId || ("_unsaved-" + runId);        // 콘텐츠(작업)별 폴더 — 저장 전이면 _unsaved
    const imageModel = String(p.imageModel || p.model || "").trim();   // 클라가 선택한 이미지 모델(별도 필드; 구버전 호환으로 model 도 수용)
    const gen = await provider.runImage({ prompt, model: (p.model || "").toString().trim(), kind, imageModel });   // kind → 콘텐츠 종류별 size(비율) 강제, imageModel → 이미지 모델 선택
    if (!gen.ok) return J(200, gen);
    try {
      const saved = await storage.save(`${userPrefix(auth)}content/${base}/${kind}/${runId}/${idx}.${gen.ext}`, gen.buf, gen.mime);
      // 재생성 교체: 이전 객체를 삭제해 고아 누적 방지(같은 계정·같은 작업 폴더 내, 새 키와 다를 때만 — 경로 주입 방어).
      const rk = String(p.replaceKey || "").replace(/^\/+|\/+$/g, "");
      if (rk && rk !== saved.key && rk.startsWith(`${userPrefix(auth)}content/${base}/`)) { try { await storage.del(rk); } catch (_) {} }
      return J(200, { ok: true, url: saved.url, key: saved.key, path: saved.key, mime: gen.mime, bytes: gen.buf.length });
    } catch (e) { return J(200, { ok: false, error: "이미지 저장 실패: " + (e && e.message || e) }); }
  }

  // 사용자 사진 업로드 + 브라우저에서 합성한 최종 카드(PNG) 저장 — AI 생성 없이 바이트만 검증·저장.
  //   slot="uploads" → content/<job>/uploads/<idx>.<ext> (원본 사진)
  //   slot="card"    → content/<job>/card/<runId>/<idx>.<ext> (합성 결과 — 라이브러리 썸네일·갤러리 파이프라인 재사용)
  async function upload(req, auth) {
    const p = parseBody(req); if (!p) return J(400, { ok: false, error: "잘못된 요청 본문(JSON 파싱 실패)" });
    const buf = decodeDataImage(p.data || p.dataUrl || p.b64 || "");
    if (!buf) return J(400, { ok: false, error: "이미지 데이터가 비어 있거나 잘못되었습니다." });
    if (buf.length > MAX_UPLOAD_BYTES) return J(413, { ok: false, error: "이미지가 너무 큽니다(최대 " + Math.round(MAX_UPLOAD_BYTES / 1048576) + "MB). 더 작은 사진으로 올려주세요." });
    const det = detectImage(buf);   // 클라가 보낸 확장자 불신 — 매직바이트로 실제 형식 판별
    if (!det) return J(400, { ok: false, error: "지원하지 않는 이미지 형식입니다(JPG·PNG·WEBP·GIF만)." });
    const slot = (p.slot === "card") ? "card" : "uploads";
    const runId = san(p.runId || "u", 40) || "u";
    const idx = san(p.idx != null ? p.idx : 0, 16) || "0";
    const jobId = san(p.jobId || "", 60);
    const base = jobId || ("_unsaved-" + runId);
    const key = slot === "card"
      ? `${userPrefix(auth)}content/${base}/card/${runId}/${idx}.${det.ext}`
      : `${userPrefix(auth)}content/${base}/uploads/${idx}.${det.ext}`;
    try {
      const saved = await storage.save(key, buf, det.mime);
      // 재합성 교체: 이전 객체 삭제(같은 계정·작업 폴더 내, 새 키와 다를 때만 — 경로 주입 방어).
      const rk = String(p.replaceKey || "").replace(/^\/+|\/+$/g, "");
      if (rk && rk !== saved.key && rk.startsWith(`${userPrefix(auth)}content/${base}/`)) { try { await storage.del(rk); } catch (_) {} }
      return J(200, { ok: true, url: saved.url, key: saved.key, path: saved.key, mime: det.mime, bytes: buf.length });
    } catch (e) { return J(200, { ok: false, error: "이미지 저장 실패: " + (e && e.message || e) }); }
  }

  async function video(req, auth) {
    const p = parseBody(req); if (!p) return J(400, { ok: false, error: "잘못된 요청 본문(JSON 파싱 실패)" });
    const provider = backend.providers[p.provider];
    if (!provider) return J(400, { ok: false, error: "알 수 없는 provider: " + p.provider });
    if (!provider.runVideo) return J(200, { ok: false, disabled: true, error: "이 백엔드/모델은 영상 제작을 지원하지 않습니다. 로컬 모드(codex/claude)에서 제작하세요." });
    const imagePrompt = String(p.imagePrompt || ""), motionPrompt = String(p.motionPrompt || "");
    if (!imagePrompt.trim() && !motionPrompt.trim()) return J(400, { ok: false, error: "이미지 프롬프트와 모션 프롬프트가 모두 비어 있습니다." });
    const runId = san(p.runId || "run", 40) || "run";
    const idx = san(p.idx != null ? p.idx : 0, 12) || "0";
    const kind = san(p.kind || "reels", 24) || "reels";
    const jobId = san(p.jobId || "", 60);
    const base = jobId || ("_unsaved-" + runId);
    const r = await provider.runVideo({
      engine: p.engine, imagePrompt, motionPrompt,
      videoModel: p.videoModel, imageModel: p.imageModel, aspect: p.aspect, duration: p.duration, model: p.model,
    });
    if (!r.ok) return J(200, r);
    let url = null, key = null, bytes = null, saveError = r.saveError || null;
    if (r.buf) {
      try { const s = await storage.save(`${userPrefix(auth)}content/${base}/${kind}/${runId}/${idx}${r.ext || ".mp4"}`, r.buf, r.mime); url = s.url; key = s.key; bytes = r.buf.length; }
      catch (e) { saveError = e && e.message || String(e); }
    }
    return J(200, {
      ok: true, videoUrl: r.videoUrl, url, key, path: key, bytes, saveError,
      imageUrl: r.imageUrl || null, imageJobId: r.imageJobId || null, videoJobId: r.videoJobId || null,
    });
  }

  /* ---- 작업(Job) 영속화: GET 목록 · GET 상세 · PUT/POST 저장 · DELETE ---- */
  async function jobs(req, auth) {
    const prefix = userPrefix(auth) + "jobs/";
    const idxPrefix = userPrefix(auth) + "index/";   // 목록용 경량 메타(전체 state 와 분리) — N+1 의 read 크기를 줄인다
    const m = /^\/jobs\/(.+)$/.exec(req.path);
    const id = m ? san(m[1]) : null;

    if (req.method === "GET" && !id) {
      const entries = await storage.list(prefix);   // jobs/ 가 권위 있는 작업 집합(인덱스는 보조 캐시)
      // 항목별 read(인덱스→폴백 전체본→presign)를 병렬화 — 직렬이면 작업 N개 × S3 왕복으로 목록이 수 초까지 늘어진다.
      // 항목 하나의 read 실패는 그 항목만 건너뛴다(목록 전체 500 방지).
      const metas = (await Promise.all(entries.map(async (e) => {
        if (!e.key.endsWith(".json")) return null;
        const jid = e.key.slice(prefix.length).replace(/\.json$/, "");
        try {
          let meta = await storage.getJson(idxPrefix + jid + ".json");   // 경량 인덱스 우선(작고 빠름)
          if (!meta || !meta.id) {                                       // 인덱스 없음(레거시/유실) → 전체를 읽어 계산하고 인덱스 백필(다음부터 빠름)
            const j = await storage.getJson(e.key);
            if (!j || !j.id) return null;
            meta = metaOfRaw(j);
            try { await storage.putJson(idxPrefix + jid + ".json", meta); } catch (_) {}
          }
          return await withThumbUrl(meta);
        } catch (_) { return null; }
      }))).filter(Boolean);
      // 제목 검색(?q=) — 인덱스 메타의 title 부분일치(대소문자 무시). 구조 변경 없이 메타만 필터.
      const q = String((req.query && (req.query.get ? req.query.get("q") : req.query.q)) || "").trim().toLowerCase();
      const filtered = q ? metas.filter((m) => String(m.title || "").toLowerCase().includes(q)) : metas;
      filtered.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));   // 최신순(수정일 내림차순)
      return J(200, { ok: true, jobs: filtered });
    }
    if (req.method === "GET" && id) {
      const j = await storage.getJson(prefix + id + ".json");
      if (!j) return J(404, { ok: false, error: "작업을 찾을 수 없습니다." });
      await resolveMediaUrls(j.state);
      return J(200, { ok: true, job: j });
    }
    if (req.method === "PUT" || req.method === "POST") {
      const body = parseBody(req); if (!body) return J(400, { ok: false, error: "잘못된 요청 본문(JSON 파싱 실패)" });
      // 빈 작업 저장 거부(클라이언트 jobHasContent 가드의 서버측 이중화 — 스크립트/멀티유저로 빈 항목이 목록에 쌓이지 않도록).
      if (body.state && typeof body.state === "object" && !stateHasContent(body.state) && !String(body.title || "").trim()) {
        return J(400, { ok: false, error: "저장할 내용이 없는 빈 작업입니다." });
      }
      const jid = id || san(body.id) || genId();
      const existing = await storage.getJson(prefix + jid + ".json");
      const now = nowIso();
      const title = (String(body.title || "").trim().slice(0, 200)) || (existing && existing.title) || "제목 없음";
      const platform = body.platform || (existing && existing.platform) || "";
      const state = (body.state && typeof body.state === "object") ? mergeMediaPlaceholders(body.state, existing && existing.state) : (existing && existing.state) || {};
      // 내용 변화 없으면 updatedAt 유지·재저장 생략 — '작업 열어보기'처럼 편집 없는 PUT 으로 updatedAt 이 바뀌어 목록 정렬이 흔들리지 않도록.
      if (existing && existing.title === title && existing.platform === platform && JSON.stringify(existing.state || {}) === JSON.stringify(state)) {
        return J(200, { ok: true, id: jid, createdAt: existing.createdAt, updatedAt: existing.updatedAt || now, unchanged: true });
      }
      const job = { id: jid, title, platform, createdAt: (existing && existing.createdAt) || now, updatedAt: now, state };
      await storage.putJson(prefix + jid + ".json", job);
      try { await storage.putJson(idxPrefix + jid + ".json", metaOfRaw(job)); } catch (_) {}   // 목록용 경량 인덱스 동시 갱신
      return J(200, { ok: true, id: jid, createdAt: job.createdAt, updatedAt: now });
    }
    if (req.method === "DELETE" && id) {
      await storage.del(prefix + id + ".json");
      try { await storage.del(idxPrefix + id + ".json"); } catch (_) {}   // 경량 인덱스도 제거
      // 콘텐츠 미디어 cascade 삭제(content/<jobId>/ 하위) — 안 하면 S3 에 고아 미디어가 남는다.
      try {
        const mediaPrefix = userPrefix(auth) + "content/" + id + "/";
        const objs = await storage.list(mediaPrefix);
        for (const o of objs) { try { await storage.del(o.key); } catch (_) {} }
      } catch (_) {}
      return J(200, { ok: true });
    }
    return J(405, { ok: false, error: "허용되지 않은 메서드" });
  }

  function normalizePromptDoc(doc) {
    const base = (doc && typeof doc === "object" && !Array.isArray(doc)) ? doc : {};
    const platforms = (base.platforms && typeof base.platforms === "object" && !Array.isArray(base.platforms)) ? base.platforms : {};
    return { version: Number(base.version || 1), platforms, updatedAt: base.updatedAt || null };
  }

  // 공통 프롬프트 템플릿(prod/meta) + 계정별 프롬프트 템플릿(prod/{admin_idx}/meta).
  async function promptTemplates(req, auth) {
    const commonKey = "prod/meta/prompt-templates.json";
    const accountKey = userPrefix(auth) + "meta/prompt-templates.json";
    if (req.method === "GET") {
      const common = normalizePromptDoc(await storage.getJson(commonKey));
      const account = normalizePromptDoc(await storage.getJson(accountKey));
      return J(200, { ok: true, common, account, keys: { common: commonKey, account: accountKey } });
    }
    if (req.method === "PUT" || req.method === "POST") {
      const body = parseBody(req);
      if (!body) return J(400, { ok: false, error: "잘못된 요청 본문(JSON 파싱 실패)" });
      const scope = body.scope === "common" ? "common" : "account";
      const raw = (body.templates && typeof body.templates === "object") ? body.templates : body;
      const now = nowIso();
      const doc = normalizePromptDoc({ ...raw, updatedAt: now });
      const key = scope === "common" ? commonKey : accountKey;
      await storage.putJson(key, doc);
      return J(200, { ok: true, scope, key, templates: doc, updatedAt: now });
    }
    return J(405, { ok: false, error: "허용되지 않은 메서드" });
  }

  // 전역 프롬프트 템플릿. 신규 경로(prod/meta)를 우선 사용하고, 기존 루트 meta 는 호환용 fallback.
  async function templates() {
    const t = (await storage.getJson("prod/meta/prompt-templates.json")) || (await storage.getJson("meta/prompt-templates.json"));
    return J(200, { ok: true, templates: t || null });
  }
  // 계정별 설정(prod/{admin_idx}/meta.json). GET 로드 / PUT 저장. 계정 격리(userPrefix).
  async function accountMeta(req, auth) {
    const key = userPrefix(auth) + "meta.json";
    if (req.method === "GET") { const m = await storage.getJson(key); return J(200, { ok: true, meta: m || null }); }
    if (req.method === "PUT" || req.method === "POST") {
      const body = parseBody(req); if (!body) return J(400, { ok: false, error: "잘못된 요청 본문(JSON 파싱 실패)" });
      const payload = (body.meta && typeof body.meta === "object") ? body.meta : body;
      const now = nowIso();
      await storage.putJson(key, { ...payload, updatedAt: now });
      return J(200, { ok: true, updatedAt: now });
    }
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

    // /health 는 인증 게이트 앞에서 응답 — 외부 uptime/LB 헬스체크가 토큰 없이도 200 을 받도록(provider 키 값 등 민감정보는 없음).
    if (req.method === "GET" && req.path === "/health") return health();

    // 약국 소개 카드뉴스 — 공개(로그인 없음), 전용 폴더 pharmacy/. 인증 게이트 앞에 둔다.
    //   /pharmacy/run(문구 생성·서버 provider) · /pharmacy/upload(사진·합성카드 저장) · /pharmacy/jobs(목록·CRUD)
    const PHARM_AUTH = { ok: true, pharmacy: true };
    if (req.method === "POST" && req.path === "/pharmacy/run") return run(req);
    if (req.method === "POST" && req.path === "/pharmacy/upload") return upload(req, PHARM_AUTH);
    if (req.path === "/pharmacy/jobs" || req.path.startsWith("/pharmacy/jobs/")) {
      return jobs({ ...req, path: req.path.replace(/^\/pharmacy/, "") }, PHARM_AUTH);
    }

    let auth = { ok: true, userId: null };
    if (requireAuth) {
      auth = await verifyToken(bearer(req.headers["authorization"]));
      if (!auth || !auth.ok) return J(401, { ok: false, error: (auth && auth.error) || "인증이 필요합니다." });
    }

    if (req.method === "GET" && req.path === "/models") return models();
    if (req.method === "POST" && req.path === "/run") return run(req);
    if (req.method === "POST" && req.path === "/image") return image(req, auth);
    if (req.method === "POST" && req.path === "/upload") return upload(req, auth);
    if (req.method === "POST" && req.path === "/video") return video(req, auth);
    if (req.path === "/jobs" || req.path.startsWith("/jobs/")) return jobs(req, auth);
    if (req.path === "/prompt-templates") return promptTemplates(req, auth);
    if (req.method === "GET" && req.path === "/templates") return templates();
    if (req.path === "/meta") return accountMeta(req, auth);

    return J(404, { ok: false, error: "Not found" });
  }

  return { handle };
}
