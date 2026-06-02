#!/usr/bin/env node
/* ============================================================================
 * bridge.mjs — 로컬 LLM CLI 브리지 (Node 18+ 내장 모듈만, 의존성 0)
 *
 * 역할: 브라우저 콘솔(content-orchestrator.html)이 보낸 프롬프트를 받아,
 *       로컬에 설치된 LLM CLI(codex / claude / agy)를 터미널에서 실행하고
 *       그 stdout(최종 답변)을 돌려준다. HTML도 같이 서빙해 same-origin으로 만든다.
 *
 * 실행:  node bridge.mjs           → http://127.0.0.1:8787 접속
 *        PORT=9000 node bridge.mjs → 포트 변경
 *
 * 보안:  127.0.0.1 에만 바인딩(외부 네트워크 노출 안 됨). 프롬프트는 쉘을 거치지 않고
 *        spawn 의 인자 배열(argv) 마지막 요소로 전달 → 명령 주입 불가. stdin 은 무시
 *        (Codex 의 non-TTY 파이프 무한대기 회피). API 키는 다루지 않음(각 CLI 자체 로그인).
 *        콘솔을 쓸 때만 켜두고 끝나면 Ctrl+C 로 종료하세요.
 *
 * CLI 매핑(플래그)은 아래 PROVIDERS 한 곳만 고치면 됩니다.
 * ========================================================================== */

import http from "node:http";
import { spawn } from "node:child_process";
import { readFile, mkdir, writeFile, readdir, rm, mkdtemp, stat, symlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, sep, extname } from "node:path";
import os from "node:os";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT) || 8787;
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS) || 240000; // CLI 1회 실행 최대 대기(기본 4분)
const MAX_BODY = 4 * 1024 * 1024;                            // 요청 본문 최대 4MB
const HTML_FILE = "content-orchestrator.html";
const __dir = dirname(fileURLToPath(import.meta.url));
const RUN_CWD = os.tmpdir();                                 // CLI 를 중립 디렉터리에서 실행(저장소 파일 안 읽게)
const IS_WIN = process.platform === "win32";
// 생성 이미지 저장 폴더 — '작업 디렉터리(콘솔을 실행한 폴더)' 기준으로 output/ 하위에 둔다.
const OUTPUT_DIR = resolve(process.cwd(), "output");
const IMAGE_TIMEOUT_MS = Number(process.env.IMAGE_TIMEOUT_MS) || 180000;  // 이미지 1장 생성 최대 대기
const VIDEO_TIMEOUT_MS = Number(process.env.VIDEO_TIMEOUT_MS) || 600000;  // 영상 1컷 생성 최대 대기(기본 10분 — 이미지 생성+영상 렌더+잡 폴링 포함)
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov", ".m4v"]);
const MEDIA_EXTS = new Set([...IMAGE_EXTS, ...VIDEO_EXTS]);   // /output 정적 서빙 허용 확장자(이미지+영상)

/* provider -> { cmd, args(model) }. 프롬프트는 항상 args 뒤에 push 된다(인자 전달). */
// ⚠ 안전: claude 의 권한 우회(--dangerously-skip-permissions)는 기본 OFF.
//   승인 게이트를 끄고 임의 프롬프트를 자율 실행하는 위험이 있으므로, 사용자가 위험을 이해하고
//   명시적으로 켤 때만 사용한다:  BRIDGE_CLAUDE_SKIP_PERMS=1 node bridge.mjs
const CLAUDE_SKIP_PERMS = /^(1|true|yes)$/i.test(process.env.BRIDGE_CLAUDE_SKIP_PERMS || "");

const PROVIDERS = {
  // codex: 신뢰 디렉터리/깃 저장소가 아니면 --skip-git-repo-check 필요(임시 폴더에서 실행하므로 필수).
  //        codex 자체 기본 샌드박스/승인 정책은 유지된다.
  codex:  { cmd: "codex",  args: (m) => ["exec", "--skip-git-repo-check", ...(m ? ["--model", m] : [])] },
  // claude: 기본은 표준 print 모드(승인 게이트 유지). 환경변수로 옵트인 시에만 권한 우회 플래그 추가.
  claude: { cmd: "claude", args: (m) => ["-p", ...(CLAUDE_SKIP_PERMS ? ["--dangerously-skip-permissions"] : []), ...(m ? ["--model", m] : [])] },
  // agy: Google Antigravity 에이전트 CLI(Gemini 모델). print 모드 `-p`.
  //   ⚠ 동작이 비대칭이다(실측):
  //     - 모델 미지정: `agy -p "<프롬프트>"`        → 프롬프트는 argv 위치 인자.
  //     - 모델 지정  : `echo "<프롬프트>" | agy -p --model=<flash|pro|flash_lite>` → 프롬프트는 STDIN.
  //                   (이때 argv 위치 인자는 무시되고, 미입력 시 코딩 에이전트 인사말만 나온다)
  //   그래서 모델이 있으면 stdinPrompt 로 표시해 프롬프트를 stdin 으로 보낸다.
  agy: { cmd: "agy", args: (m) => ["-p", ...(m ? ["--model=" + m] : [])], stdinPrompt: (m) => !!m },
};

/* ---- 유틸 ---------------------------------------------------------------- */

// 루프백(로컬) origin 만 허용한다. 임의의 외부 사이트가 사용자의 브라우저를 통해
// 로컬 /run 을 호출, 설치된 LLM CLI 를 실행시키는 drive-by(로컬 SSRF) 공격을 차단.
// Origin 헤더가 없으면(동일 origin GET·curl·로컬 도구 등) 허용한다.
function originAllowed(origin) {
  if (!origin) return true;
  try {
    const h = new URL(origin).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
  } catch (_) { return false; }   // 'null'(file://) 등 파싱 불가 origin → 거부
}

function setCors(req, res) {
  const origin = req.headers.origin;
  // 루프백 origin 에만 CORS 를 허용(그 외엔 헤더를 주지 않아 브라우저의 교차 출처 응답 읽기를 차단).
  if (originAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
}

// 모든 응답에 붙일 캐시 무력화 헤더(브라우저가 /health·/models 등 GET 응답을 캐시하지 못하게)
const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate", "Pragma": "no-cache", "Expires": "0" };

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...NO_CACHE });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("요청 본문이 너무 큽니다.")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/* 표시용 명령 문자열(프롬프트는 길이만) */
function displayCommand(cmd, args, prompt) {
  return [cmd, ...args].join(" ") + ` "<프롬프트 ${prompt.length}자>"`;
}

/* CLI 가 PATH 에 있는지 감지 */
function detect(cmd) {
  return new Promise((resolve) => {
    const probe = IS_WIN ? "where" : "which";
    const p = spawn(probe, [cmd], { stdio: ["ignore", "ignore", "ignore"] });
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
  });
}

async function detectAll() {
  const out = {};
  await Promise.all(
    Object.keys(PROVIDERS).map(async (k) => { out[k] = await detect(PROVIDERS[k].cmd); })
  );
  return out;
}

/* ---- 모델 목록 조회(최신화) -------------------------------------------------
 * 각 CLI 가 제공하는 "실제 모델 목록"을 가능한 한 CLI 출처에서 가져온다.
 *  - codex : ~/.codex/models_cache.json (codex 가 서버에서 받아 etag 로 캐시) → visibility!=hide 만, priority 순.
 *  - agy   : `agy --help` 의 --model=<flash_lite|flash|pro> 토큰을 파싱(없으면 고정 티어).
 *  - claude: CLI 에 목록 조회 명령이 없음 → 알려진 기본 세트(별칭/버전 핀).
 * 반환: { models:[{id,tag}], source } (실패 시 error 포함)
 */
function shortCmd(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = "", err = "", done = false;
    let child;
    try { child = spawn(cmd, args, { cwd: RUN_CWD, stdio: ["ignore", "pipe", "pipe"], env: process.env }); }
    catch (e) { resolve({ ok: false, error: e.message }); return; }
    const fin = (o) => { if (done) return; done = true; clearTimeout(t); resolve(o); };
    const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch (_) {} fin({ ok: false, error: "timeout", out, err }); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", (e) => fin({ ok: false, error: e.message }));
    child.on("close", (code) => fin({ ok: code === 0, code, out, err }));
  });
}

// codex 슬러그 → 오른쪽에 보일 특성 태그(가성비/저렴 식). 모르면 슬러그 규칙으로 추정.
function codexTag(slug, idxFromTop) {
  const M = {
    "gpt-5.5": "최신·권장", "gpt-5.4": "이전 세대", "gpt-5.4-mini": "저렴·빠름",
    "gpt-5.3-codex": "코딩 특화", "gpt-5.2": "구형",
  };
  if (M[slug]) return M[slug];
  if (/mini|nano|lite|flash/i.test(slug)) return "저렴·빠름";
  if (/codex/i.test(slug)) return "코딩 특화";
  return idxFromTop === 0 ? "권장" : "";
}

async function listCodexModels() {
  const home = process.env.CODEX_HOME || join(os.homedir(), ".codex");
  const file = join(home, "models_cache.json");
  try {
    const raw = await readFile(file, "utf8");
    const data = JSON.parse(raw);
    const list = Array.isArray(data.models) ? data.models : [];
    const models = list
      .filter((m) => m && m.slug && m.visibility !== "hide")
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
      .map((m, i) => ({ id: m.slug, tag: codexTag(m.slug, i) }));
    return { models, source: "codex 모델 캐시 (models_cache.json)", fetchedAt: data.fetched_at || null };
  } catch (e) {
    return { models: [], source: "codex 모델 캐시", error: "models_cache.json 읽기 실패: " + e.message };
  }
}

async function listAgyModels() {
  // 티어별 친근한 이름(왼쪽 표시) + 특성(오른쪽 표시)
  const META = {
    flash: { name: "Gemini 3.5 Flash", tag: "가성비" },
    pro: { name: "Gemini 3.1 Pro", tag: "고성능" },
    flash_lite: { name: "Flash Lite", tag: "저렴" },
  };
  const r = await shortCmd("agy", ["--help"], 20000);
  const text = (r.out || "") + (r.err || "");
  const m = text.match(/--model=<([^>]+)>/);
  let tiers = m ? m[1].split("|").map((s) => s.trim()).filter(Boolean) : [];
  if (!tiers.length) tiers = ["flash", "pro", "flash_lite"]; // 파싱 실패 시 알려진 티어
  return { models: tiers.map((t) => ({ id: t, name: (META[t] && META[t].name) || t, tag: (META[t] && META[t].tag) || "" })), source: "agy --help" };
}

function listClaudeModels() {
  // claude CLI 는 모델 목록 조회 명령이 없음 → 알려진 기본 세트(정식 버전 핀 ID).
  return {
    models: [
      { id: "claude-sonnet-4-6", tag: "일반" },
      { id: "claude-opus-4-8", tag: "고성능" },
      { id: "claude-haiku-4-5-20251001", tag: "저렴/빠름" },
    ],
    source: "기본 세트 (claude CLI는 목록 조회 미지원)",
  };
}

async function listModelsAll() {
  const [codex, agy] = await Promise.all([listCodexModels(), listAgyModels()]);
  return { codex, agy, claude: listClaudeModels() };
}

/* ---- 이미지 생성 (agy / codex 로 실제 이미지 생성) --------------------------
 * agy: 비대화형에서도 cwd 에 이미지 파일을 저장(실측).
 * codex: 이미지를 ~/.codex/generated_images/<session>/ig_*.png 에 저장하고, 가끔 NO_IMAGE_GEN
 *        으로 오보하므로, 실행 시작 이후 mtime 의 새 이미지 파일을 그 폴더에서 회수한다.
 * 어느 쪽이든 확장자가 실제 형식과 다를 수 있어(JPEG 를 .png 로 저장 등) 매직바이트로 판별. */
const CODEX_IMG_DIR = join(process.env.CODEX_HOME || join(os.homedir(), ".codex"), "generated_images");
const IMAGE_PROVIDERS = {
  agy:   { args: (instr) => ["-p", instr] },
  codex: { args: (instr) => ["exec", "--skip-git-repo-check", instr], extraDir: CODEX_IMG_DIR },
};
function detectImage(buf) {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: "png", mime: "image/png" };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return { ext: "webp", mime: "image/webp" };
  if (buf.length >= 4 && buf.toString("ascii", 0, 4) === "GIF8") return { ext: "gif", mime: "image/gif" };
  return null;
}
function mimeForExt(ext) {
  return ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
    ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".m4v": "video/x-m4v" })[ext.toLowerCase()] || "application/octet-stream";
}

// dir 안에서 이미지 파일 후보 수집(sinceMs 이후 mtime 만, recursive 옵션). [{buf,det,mtime}]
async function collectImages(dir, sinceMs, recursive) {
  let names;
  try { names = await readdir(dir, { recursive: !!recursive }); } catch { return []; }
  const out = [];
  for (const name of names) {
    const p = join(dir, name);
    let s;
    try { s = await stat(p); } catch { continue; }
    if (!s.isFile()) continue;
    if (sinceMs && s.mtimeMs < sinceMs) continue;
    let buf;
    try { buf = await readFile(p); } catch { continue; }
    const det = detectImage(buf);
    if (det) out.push({ buf, det, mtime: s.mtimeMs });
  }
  return out;
}

// 선택한 도구(agy|codex)로 이미지 1장 생성 → { ok, buf, ext, mime } 또는 { ok:false, error }
async function generateImage(provider, prompt) {
  const def = IMAGE_PROVIDERS[provider] || IMAGE_PROVIDERS.agy;
  const cmd = provider === "codex" ? "codex" : "agy";
  const scratch = await mkdtemp(join(os.tmpdir(), "cm-img-"));
  const startedAt = Date.now() - 3000;   // mtime 필터 버퍼(공유 폴더에서 이번 실행분만 회수)
  // codex 는 이미지를 공유 ~/.codex/generated_images 에 저장 → 병렬 실행 시 서로의 이미지를 가져가는 레이스 발생.
  // 호출마다 고유 CODEX_HOME(인증·설정 심볼릭 링크)을 줘 generated_images 를 격리한다(병렬 안전). agy 는 scratch 에 저장하므로 불필요.
  let runHome = null, runEnv = process.env, extraDir = def.extraDir;
  if (provider === "codex") {
    const realHome = process.env.CODEX_HOME || join(os.homedir(), ".codex");
    runHome = await mkdtemp(join(os.tmpdir(), "cm-codexhome-"));
    for (const f of ["auth.json", "config.toml"]) {   // 토큰 복사 없이 링크로 격리
      try { await symlink(join(realHome, f), join(runHome, f)); } catch (_) {}
    }
    runEnv = { ...process.env, CODEX_HOME: runHome };
    extraDir = join(runHome, "generated_images");
  }
  try {
    // 운영 지시문은 영어(이미지 도구 트리거가 안정적). 창작 프롬프트(prompt)는 한국어다.
    // ⚠ agy 가 한국어 프롬프트를 '코딩 작업'으로 오해해 PIL/파이썬으로 그림을 그리는 일이 있어, 네이티브 이미지 생성만 쓰고 코드 작성을 금지하도록 강하게 지시한다.
    const instruction =
      "Use your built-in native image-generation model to directly generate ONE image from the prompt below, then save it as out.png in the current working directory. " +
      "CRITICAL: do NOT write or run any code or script (no Python, PIL, matplotlib, SVG, HTML, canvas) to draw it — you MUST produce the image with your image-generation model. " +
      "OUTPUT MUST BE ONE single finished, full-bleed composition that fills the entire frame as a real final artwork (one poster/one slide). " +
      "It is NOT a grid, collage, contact sheet, moodboard, storyboard, design-system board, style guide, template gallery, slideshow, mockup, or a set of multiple panels/thumbnails. " +
      "Any colors, hex codes, margins, or 'design system' notes in the prompt are STYLING GUIDANCE for that single artwork — never lay them out as labeled swatches or a board. Render the actual described scene/subject, on-topic, edge to edge. " +
      "If the prompt asks for on-image text, render that exact Korean text clearly and legibly with correct spelling (no fake or broken letters). " +
      "Do not ask any questions. After saving, print only the saved file path. If you truly cannot generate an image, print exactly NO_IMAGE_GEN.\n\nThe image prompt is written in Korean:\n" + prompt;
    const result = await new Promise((res) => {
      let out = "", err = "", done = false;
      let child;
      try { child = spawn(cmd, def.args(instruction), { cwd: scratch, stdio: ["ignore", "pipe", "pipe"], env: runEnv }); }
      catch (e) { res({ ok: false, error: cmd + " 실행 시작 실패: " + e.message }); return; }
      const fin = (o) => { if (done) return; done = true; clearTimeout(t); res(o); };
      const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch (_) {} fin({ ok: false, error: `이미지 생성 시간 초과(${Math.round(IMAGE_TIMEOUT_MS / 1000)}s)` }); }, IMAGE_TIMEOUT_MS);
      child.stdout.on("data", (d) => { out += d.toString(); });
      child.stderr.on("data", (d) => { err += d.toString(); });
      child.on("error", (e) => fin({ ok: false, error: e.code === "ENOENT" ? (cmd + " CLI 를 찾을 수 없습니다(설치/PATH 확인).") : (cmd + " 실행 오류: " + e.message) }));
      child.on("close", () => fin({ ok: true, out, err }));
    });
    if (!result.ok) return result;
    // 후보: 이번 호출 전용 scratch 폴더를 우선(병렬 실행에도 안전 — 다른 호출 이미지와 섞이지 않음).
    // scratch 가 비었을 때만 공유 generated_images 로 폴백(codex 가 cwd 에 저장 안 한 경우; 병렬 시 드물게 교차 가능).
    let cands = await collectImages(scratch, 0, false);
    if (!cands.length && extraDir) cands = await collectImages(extraDir, startedAt, true);
    if (!cands.length) {
      const snip = (result.out || "").trim().slice(0, 200);
      return { ok: false, error: "이미지 파일을 찾지 못했습니다." + (snip ? " 응답: " + snip : "") };
    }
    cands.sort((a, b) => b.buf.length - a.buf.length);   // 실사 이미지가 보통 가장 큼
    const best = cands[0];
    return { ok: true, buf: best.buf, ext: best.det.ext, mime: best.det.mime };
  } finally {
    rm(scratch, { recursive: true, force: true }).catch(() => {});   // timeout 시에도 누수 방지
    if (runHome) rm(runHome, { recursive: true, force: true }).catch(() => {});   // 격리 CODEX_HOME 정리
  }
}

/* ---- 영상 제작 (LLM CLI + MCP 영상 엔진) ------------------------------------
 * 흐름: 콘솔이 보낸 컷(스틸 이미지 프롬프트 + 모션 프롬프트)을 받아, MCP 영상 엔진이
 *       연결된 LLM CLI(codex/claude)에게 "이미지를 엔진에 등록(생성)하고 그 스틸로
 *       영상을 만들라"는 지시문을 보낸다. CLI 는 자기 MCP(예: higgsfield)를 자율 호출해
 *       generate_image → generate_video(start_image) → job_status 폴링까지 수행하고,
 *       마지막 줄에 RESULT_JSON 한 줄(영상 URL 등)을 출력한다. 브리지는 그 URL 의
 *       영상을 내려받아 output/<runId>/<idx>.mp4 로 저장하고 콘솔에 돌려준다.
 *  - 영상 엔진은 각 CLI 에 설정된 MCP 서버를 사용한다(현재 higgsfield). agy 는 MCP 미연동 → 제외.
 *  - 실제 MCP 도구 호출은 CLI 가 도구 스키마를 직접 탐색해 수행하므로, 지시문은 자연어로 충분하다. */
const VIDEO_PROVIDERS = new Set(["codex", "claude"]);     // MCP 영상 엔진을 자율 호출할 수 있는 CLI 만
const VIDEO_ENGINES = {
  // 엔진 키 → { label, mcp(지시문에 쓸 MCP 서버명), defaultModel }
  higgsfield: { label: "Higgsfield", mcp: "higgsfield", defaultModel: "seedance_1_5", defaultImageModel: "nano_banana_pro" },
};
// claude 영상 경로 전용: '생성·상태 조회·결과 표시'에 필요한 최소 도구만 자율 허용한다.
// (= 형 단일 토큰 → 위치인자 프롬프트 보존, --dangerously-skip-permissions 불필요. 로컬 파일 업로드(media_upload 등)는
//  이 흐름에서 불필요하므로 제외해 prompt-injection 도구 surface 를 줄인다.)
// claude 의 MCP 클라이언트는 codex 와 달리 서버 거부(예: 플랜 제한)를 '취소'로 가리지 않고 원문 오류를 그대로 표출한다.
const CLAUDE_HIGGSFIELD_TOOLS = "--allowedTools=mcp__higgsfield__generate_image,mcp__higgsfield__generate_video,mcp__higgsfield__job_status,mcp__higgsfield__job_display,mcp__higgsfield__show_generations,mcp__higgsfield__reveal_generation,mcp__higgsfield__models_explore";

// CLI 에 보낼 영상 제작 지시문(영어 — MCP 도구 트리거가 안정적). 창작 프롬프트는 한국어일 수 있다.
// (모든 입력을 String() 으로 강제 — 숫자/객체 JSON 이 와도 .trim() 예외로 요청이 죽지 않게.)
function buildVideoInstruction(eng, o) {
  const vModel = String(o.videoModel || "").trim() || eng.defaultModel;
  const iModel = String(o.imageModel || "").trim() || eng.defaultImageModel;
  const aspect = String(o.aspect || "").trim() || "9:16";
  const duration = Number(o.duration) > 0 ? Number(o.duration) : 5;
  const img = String(o.imagePrompt || "").trim();
  const motion = String(o.motionPrompt || "").trim();
  const lines = [];
  lines.push(`You are operating the "${eng.mcp}" MCP server (its tools are exposed to you). Perform a vertical short-form (Reels) video shot FULLY AUTONOMOUSLY. Do NOT ask any questions, do NOT stop for confirmation.`);
  lines.push("");
  if (img) {
    lines.push(`STEP 1 — Register the still image into the engine: call the engine's image generation tool (generate_image) with model "${iModel}", aspect_ratio "${aspect}", count 1, and the IMAGE PROMPT below. If the call returns a job, poll the engine's status tool (job_status) until it is completed. Capture the resulting image job_id and the preview image URL.`);
    lines.push(`STEP 2 — Animate that still into a clip: call the engine's video generation tool (generate_video) with model "${vModel}", aspect_ratio "${aspect}", duration ${duration}, the MOTION PROMPT below as the prompt, and medias = [{ "value": "<image job_id from STEP 1>", "role": "start_image" }].`);
  } else {
    lines.push(`STEP 1 — Generate a clip directly: call the engine's video generation tool (generate_video) with model "${vModel}", aspect_ratio "${aspect}", duration ${duration}, and the MOTION PROMPT below as the prompt.`);
  }
  lines.push(`STEP 3 — Poll the engine's status tool (job_status) until the VIDEO job is completed and you have the final downloadable video URL (an .mp4 link).`);
  lines.push("");
  lines.push(`ERROR HANDLING — if ANY step fails for ANY reason (insufficient credits, quota, an invalid parameter, or the engine returning a "recovery_tool" / structuredContent.recovery_tool such as show_plans_and_credits): do NOT call that recovery tool, do NOT call show_plans_and_credits or any other tool, do NOT explain or ask. Instead immediately print the RESULT_JSON failure line below (with a short human reason, e.g. "insufficient credits") and STOP. The RESULT_JSON line is the ONLY acceptable final output in every case.`);
  lines.push("");
  lines.push(`FINAL OUTPUT — print EXACTLY ONE line and nothing after it, raw JSON with NO markdown fences, in this exact shape:`);
  lines.push(`RESULT_JSON: {"ok":true,"image_url":"<preview image url or empty>","image_job_id":"<id or empty>","video_job_id":"<id>","video_url":"<final mp4 url>"}`);
  lines.push(`If you cannot finish, print exactly: RESULT_JSON: {"ok":false,"error":"<short reason>"}`);
  lines.push("");
  if (img) { lines.push("IMAGE PROMPT (the still that opens the clip; may be Korean — render any on-image Korean text exactly):"); lines.push(img); lines.push(""); }
  lines.push("MOTION PROMPT (camera move / motion for the clip; if empty, infer subtle natural motion that fits the still):");
  lines.push(motion || "(none — infer subtle, natural motion that fits the still and the Reels format)");
  return lines.join("\n");
}

// 마지막 RESULT_JSON 라인을 파싱(없으면 .mp4 URL 추출로 폴백)
function parseResultJson(text) {
  const lines = String(text || "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const at = lines[i].indexOf("RESULT_JSON:");
    if (at < 0) continue;
    const raw = lines[i].slice(at + "RESULT_JSON:".length).trim();
    try { return JSON.parse(raw); } catch (_) { /* 계속 위로 탐색 */ }
  }
  // 폴백: RESULT_JSON 라인이 전혀 없을 때만, stdout 에서 https .mp4 URL 하나를 최후의 수단으로 추출.
  // (https 전용 — 다운로드 단계의 assertSafeMediaUrl 가 내부/사설 호스트는 다시 차단한다.)
  const m = String(text || "").match(/https:\/\/[^\s"')\]]+\.mp4[^\s"')\]]*/);
  if (m) return { ok: true, video_url: m[0], _fallback: true };
  return null;
}

const MEDIA_DL_TIMEOUT_MS = Number(process.env.MEDIA_DL_TIMEOUT_MS) || 120000;  // 원격 영상 다운로드 최대 대기(2분)
const MAX_MEDIA_BYTES = Number(process.env.MAX_MEDIA_BYTES) || 256 * 1024 * 1024; // 다운로드 영상 최대 크기(256MB)
// 선택: 다운로드 허용 호스트 화이트리스트(쉼표 구분). 비우면 'https + 비-내부' 만 통과. 예: MEDIA_HOST_ALLOWLIST=cloudfront.net,higgsfield.ai
const MEDIA_HOST_ALLOWLIST = (process.env.MEDIA_HOST_ALLOWLIST || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

// 모델이 RESULT_JSON 으로 돌려준 영상 URL 을 안전하게 검증(https 전용 + 내부/루프백/사설 주소 차단 + 선택적 allowlist → SSRF 방어).
function assertSafeMediaUrl(u) {
  let parsed;
  try { parsed = new URL(String(u)); } catch { throw new Error("잘못된 영상 URL"); }
  if (parsed.protocol !== "https:") throw new Error("https URL 만 허용됩니다");
  const h = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isPrivate =
    h === "localhost" || h === "::1" || h === "0.0.0.0" || h.endsWith(".local") ||
    /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^(fc|fd)[0-9a-f]{2}:/.test(h) || /^fe80:/.test(h);
  if (isPrivate) throw new Error("내부/사설 호스트로의 다운로드는 차단됩니다");
  if (MEDIA_HOST_ALLOWLIST.length && !MEDIA_HOST_ALLOWLIST.some((d) => h === d || h.endsWith("." + d))) {
    throw new Error("허용되지 않은 다운로드 호스트: " + h);
  }
  return parsed;
}

// 원격 영상(MCP 엔진 CDN)을 브리지가 내려받아 output/<runId>/<idx>.<ext> 로 저장(로컬 사본·다운로드용).
// 리디렉션은 수동으로 따라가며 각 hop 의 Location 을 다시 검증한다(redirect 를 통한 SSRF 우회 차단).
async function downloadMediaToOutput(url, runId, idx) {
  let current = assertSafeMediaUrl(url);                 // https + 비-내부(+allowlist) 만
  let resp;
  for (let hop = 0; hop < 4; hop++) {
    resp = await fetch(current, { signal: AbortSignal.timeout(MEDIA_DL_TIMEOUT_MS), redirect: "manual" });
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get("location");
      if (!loc) throw new Error("리디렉션 Location 헤더가 없습니다");
      current = assertSafeMediaUrl(new URL(loc, current));   // 매 hop 재검증
      continue;
    }
    break;
  }
  if (!resp || !resp.ok) throw new Error("다운로드 실패 HTTP " + (resp ? resp.status : "?"));
  const declared = Number(resp.headers.get("content-length") || 0);
  if (declared && declared > MAX_MEDIA_BYTES) throw new Error("영상이 너무 큽니다(" + Math.round(declared / 1048576) + "MB)");
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > MAX_MEDIA_BYTES) throw new Error("영상이 너무 큽니다(" + Math.round(buf.length / 1048576) + "MB)");
  let ext = extname(current.pathname).toLowerCase();
  if (!VIDEO_EXTS.has(ext)) ext = ".mp4";
  const dir = join(OUTPUT_DIR, runId);
  await mkdir(dir, { recursive: true });
  const filename = idx + ext;
  await writeFile(join(dir, filename), buf);
  return { rel: "output/" + runId + "/" + filename, bytes: buf.length, mime: mimeForExt(ext) };
}

/* LLM CLI 1회 실행
 * 기본: 프롬프트는 argv 마지막, stdin 무시(Codex non-TTY 파이프 무한대기 회피).
 * stdinPrompt(model) 가 true 인 provider(예: 모델 지정된 agy)는 프롬프트를 stdin 으로 보내고 argv 에는 넣지 않는다.
 * extraArgs: 프롬프트 앞에 끼워 넣을 추가 플래그(예: 영상 단계의 claude --allowedTools=…).
 *   ⚠ claude 는 `--allowedTools "a,b"`(공백형)가 뒤 위치인자(프롬프트)를 값으로 삼켜버리므로 반드시 `--allowedTools=a,b`(= 형) 단일 토큰으로 전달한다. */
function runCli(provider, model, prompt, timeoutMs, extraArgs) {
  const TO = timeoutMs || TIMEOUT_MS;   // 호출별 최대 대기(영상 단계는 더 길게)
  return new Promise((resolve) => {
    const def = PROVIDERS[provider];
    const baseArgs = def.args(model);
    const extra = Array.isArray(extraArgs) ? extraArgs : [];
    const useStdin = typeof def.stdinPrompt === "function" && def.stdinPrompt(model);
    const args = useStdin ? [...baseArgs, ...extra] : [...baseArgs, ...extra, prompt];
    const command = displayCommand(def.cmd, [...baseArgs, ...extra], prompt);
    const startedAt = Date.now();

    let child;
    try {
      child = spawn(def.cmd, args, {
        cwd: RUN_CWD,
        stdio: [useStdin ? "pipe" : "ignore", "pipe", "pipe"],   // 기본 stdin 무시, stdinPrompt 만 pipe
        env: process.env,
      });
    } catch (e) {
      resolve({ ok: false, error: "CLI 실행 시작 실패: " + e.message, command });
      return;
    }
    if (useStdin) {
      try { child.stdin.write(prompt); child.stdin.end(); }
      catch (e) { /* EPIPE 등은 close 핸들러에서 종료코드로 처리 */ }
    }

    let stdout = "", stderr = "", done = false;
    const finish = (obj) => { if (done) return; done = true; clearTimeout(timer); resolve(obj); };

    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch (_) {}
      finish({ ok: false, error: `시간 초과(${Math.round(TO/1000)}s) — 실행을 중단했습니다.`, command, stderr, durationMs: Date.now() - startedAt });
    }, TO);

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    child.on("error", (e) => {
      const msg = e && e.code === "ENOENT"
        ? `CLI 를 찾을 수 없습니다: '${def.cmd}'. 설치 여부와 PATH 를 확인하세요.`
        : ("CLI 실행 오류: " + (e && e.message ? e.message : String(e)));
      finish({ ok: false, error: msg, command, stderr, durationMs: Date.now() - startedAt });
    });

    child.on("close", (code) => {
      finish({
        ok: code === 0,
        code: code,
        output: stdout,
        stderr: stderr,
        command: command,
        durationMs: Date.now() - startedAt,
        error: code === 0 ? undefined : `CLI 가 0이 아닌 코드(${code})로 종료되었습니다.`,
      });
    });
  });
}

/* ---- HTTP 서버 ----------------------------------------------------------- */

const server = http.createServer(async (req, res) => {
  setCors(req, res);

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const path = url.pathname;

  // 콘솔 HTML 서빙(same-origin)
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

  // 상태/감지
  if (req.method === "GET" && path === "/health") {
    const providers = await detectAll();
    sendJson(res, 200, { ok: true, providers, port: PORT, cwd: RUN_CWD });
    return;
  }

  // 모델 목록 최신화(각 CLI 출처에서 조회)
  if (req.method === "GET" && path === "/models") {
    // 이 엔드포인트는 로컬 프로세스(agy --help 등)를 spawn 하므로, 외부 사이트의 반복 GET 으로
    // 로컬 프로세스를 생성하지 못하게 origin 을 검증한다(same-origin·도구는 Origin 헤더가 없거나 루프백).
    if (!originAllowed(req.headers.origin)) { sendJson(res, 403, { ok: false, error: "허용되지 않은 출처입니다." }); return; }
    try {
      const providers = await listModelsAll();
      sendJson(res, 200, { ok: true, providers });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: "모델 목록 조회 실패: " + (e && e.message ? e.message : String(e)) });
    }
    return;
  }

  // CLI 실행
  if (req.method === "POST" && path === "/run") {
    // text/plain POST 는 preflight 를 우회하므로 CORS 헤더만으로는 부족 — 실행 경로에서 직접 차단.
    if (!originAllowed(req.headers.origin)) {
      sendJson(res, 403, { ok: false, error: "허용되지 않은 출처입니다. 로컬(127.0.0.1) 콘솔에서만 실행할 수 있습니다." });
      return;
    }
    let payload;
    try { payload = JSON.parse(await readBody(req)); }
    catch (e) { sendJson(res, 400, { ok: false, error: "잘못된 요청 본문(JSON 파싱 실패): " + e.message }); return; }

    const provider = payload && payload.provider;
    const model = (payload && payload.model || "").toString().trim();
    const prompt = (payload && payload.prompt || "").toString();

    if (!PROVIDERS[provider]) { sendJson(res, 400, { ok: false, error: "알 수 없는 provider: " + provider }); return; }
    if (!prompt.trim()) { sendJson(res, 400, { ok: false, error: "prompt 가 비어 있습니다." }); return; }

    const result = await runCli(provider, model, prompt);
    sendJson(res, 200, result); // 실패도 200 + {ok:false} 로 내려 콘솔이 메시지를 표시
    return;
  }

  // 이미지 생성(agy) → 작업폴더 output/<runId>/<idx>.<ext> 에 저장하고 URL 반환
  if (req.method === "POST" && path === "/image") {
    if (!originAllowed(req.headers.origin)) { sendJson(res, 403, { ok: false, error: "허용되지 않은 출처입니다. 로컬(127.0.0.1) 콘솔에서만 가능합니다." }); return; }
    let payload;
    try { payload = JSON.parse(await readBody(req)); }
    catch (e) { sendJson(res, 400, { ok: false, error: "잘못된 요청 본문(JSON 파싱 실패): " + e.message }); return; }
    const prompt = (payload && payload.prompt || "").toString();
    if (!prompt.trim()) { sendJson(res, 400, { ok: false, error: "prompt 가 비어 있습니다." }); return; }
    const provider = (payload && payload.provider || "agy").toString();
    if (provider !== "agy" && provider !== "codex") { sendJson(res, 400, { ok: false, error: "이미지 생성은 agy 또는 codex 만 지원합니다." }); return; }
    const runId = (String(payload && payload.runId || "run").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40)) || "run";
    const idx = (String(payload && payload.idx != null ? payload.idx : 0).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12)) || "0";
    const gen = await generateImage(provider, prompt);
    if (!gen.ok) { sendJson(res, 200, gen); return; }
    try {
      const dir = join(OUTPUT_DIR, runId);
      await mkdir(dir, { recursive: true });
      const filename = idx + "." + gen.ext;
      await writeFile(join(dir, filename), gen.buf);
      const rel = "output/" + runId + "/" + filename;
      sendJson(res, 200, { ok: true, url: "/" + rel, path: rel, mime: gen.mime, bytes: gen.buf.length });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: "이미지 저장 실패: " + e.message });
    }
    return;
  }

  // 영상 제작(LLM CLI + MCP 영상 엔진) → 영상 1컷 생성 후 output/<runId>/<idx>.mp4 로 저장하고 URL 반환
  if (req.method === "POST" && path === "/video") {
    if (!originAllowed(req.headers.origin)) { sendJson(res, 403, { ok: false, error: "허용되지 않은 출처입니다. 로컬(127.0.0.1) 콘솔에서만 가능합니다." }); return; }
    let payload;
    try { payload = JSON.parse(await readBody(req)); }
    catch (e) { sendJson(res, 400, { ok: false, error: "잘못된 요청 본문(JSON 파싱 실패): " + e.message }); return; }

    const provider = (payload && payload.provider || "codex").toString();
    if (!VIDEO_PROVIDERS.has(provider)) { sendJson(res, 400, { ok: false, error: "영상 제작은 codex 또는 claude 만 지원합니다(MCP 영상 엔진 연동 필요)." }); return; }
    const engKey = (payload && payload.engine || "higgsfield").toString();
    const eng = VIDEO_ENGINES[engKey];
    if (!eng) { sendJson(res, 400, { ok: false, error: "지원하지 않는 영상 엔진: " + engKey }); return; }
    const imagePrompt = (payload && payload.imagePrompt || "").toString();
    const motionPrompt = (payload && payload.motionPrompt || "").toString();
    if (!imagePrompt.trim() && !motionPrompt.trim()) { sendJson(res, 400, { ok: false, error: "이미지 프롬프트와 모션 프롬프트가 모두 비어 있습니다." }); return; }
    const model = (payload && payload.model || "").toString().trim();   // CLI 모델(선택) — MCP 엔진 모델과 별개
    const runId = (String(payload && payload.runId || "run").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40)) || "run";
    const idx = (String(payload && payload.idx != null ? payload.idx : 0).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12)) || "0";

    const instruction = buildVideoInstruction(eng, {
      imagePrompt, motionPrompt,
      videoModel: payload && payload.videoModel, imageModel: payload && payload.imageModel,
      aspect: payload && payload.aspect, duration: payload && payload.duration,
    });
    // claude 는 --allowedTools 로 higgsfield 도구를 자율 허용(dangerous 플래그 불필요). codex 는 추가 인자 없음.
    const extraArgs = provider === "claude" ? [CLAUDE_HIGGSFIELD_TOOLS] : [];
    const run = await runCli(provider, model, instruction, VIDEO_TIMEOUT_MS, extraArgs);
    if (!run.ok && !run.output) { sendJson(res, 200, { ok: false, error: run.error || "CLI 실행 실패", stderr: (run.stderr || "").slice(-600) }); return; }

    const parsed = parseResultJson(run.output || "");
    if (!parsed) { sendJson(res, 200, { ok: false, error: "영상 결과(RESULT_JSON)를 찾지 못했습니다. 크레딧 부족이나 엔진 오류일 수 있어요(아래 raw 확인). 또는 CLI 의 MCP 영상 엔진 연결을 점검하세요.", raw: (run.output || "").slice(-600) }); return; }
    if (parsed.ok === false) { sendJson(res, 200, { ok: false, error: parsed.error || "영상 엔진이 생성에 실패했습니다.", raw: (run.output || "").slice(-400) }); return; }
    const videoUrl = (parsed.video_url || "").toString().trim();
    if (!videoUrl) { sendJson(res, 200, { ok: false, error: "영상 URL 이 비어 있습니다.", raw: (run.output || "").slice(-400) }); return; }

    // 원격 영상을 로컬에 내려받아 저장(실패해도 원격 URL 은 반환).
    let local = null;
    try { local = await downloadMediaToOutput(videoUrl, runId, idx); }
    catch (e) { local = { error: e.message }; }
    sendJson(res, 200, {
      ok: true,
      videoUrl,                                   // 엔진 원격 mp4 URL
      url: local && local.rel ? ("/" + local.rel) : null,   // 로컬 사본(있으면) — <video src> 로 재생/다운로드
      path: local && local.rel ? local.rel : null,
      bytes: local && local.bytes ? local.bytes : null,
      saveError: local && local.error ? local.error : null,
      imageUrl: (parsed.image_url || "").toString() || null,
      imageJobId: (parsed.image_job_id || "").toString() || null,
      videoJobId: (parsed.video_job_id || "").toString() || null,
    });
    return;
  }

  // 생성 이미지·영상 정적 서빙(<img>/<video> src). 경로 traversal 차단 + 미디어 확장자만. (Origin 가드 X — 미디어 로드 위해)
  if (req.method === "GET" && path.startsWith("/output/")) {
    let rel;
    try { rel = decodeURIComponent(path.slice("/output/".length)); } catch (e) { res.writeHead(400); res.end("bad path"); return; }
    const abs = resolve(OUTPUT_DIR, rel);
    if (abs !== OUTPUT_DIR && !abs.startsWith(OUTPUT_DIR + sep)) { res.writeHead(403); res.end("forbidden"); return; }
    const ext = extname(abs).toLowerCase();
    if (!MEDIA_EXTS.has(ext)) { res.writeHead(403); res.end("forbidden"); return; }
    try {
      const buf = await readFile(abs);
      res.writeHead(200, { "Content-Type": mimeForExt(ext), ...NO_CACHE });
      res.end(buf);
    } catch (e) { res.writeHead(404); res.end("not found"); }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

server.listen(PORT, HOST, async () => {
  const providers = await detectAll();
  const found = Object.keys(providers).filter((k) => providers[k]);
  const missing = Object.keys(providers).filter((k) => !providers[k]);
  console.log("──────────────────────────────────────────────");
  console.log(" 콘텐츠 파이프라인 LLM 브리지 실행 중");
  console.log("   주소 : http://" + HOST + ":" + PORT + "   ← 브라우저로 여세요");
  console.log("   감지된 CLI : " + (found.length ? found.join(", ") : "(없음)"));
  if (missing.length) console.log("   미감지 CLI : " + missing.join(", ") + "  (설치/PATH 확인)");
  console.log("   작업 디렉터리(CLI 실행) : " + RUN_CWD);
  console.log("   이미지 저장 폴더 : " + OUTPUT_DIR);
  console.log("   종료: Ctrl+C");
  console.log("──────────────────────────────────────────────");
});
