/* ============================================================================
 * backends/cli/index.mjs — 로컬 LLM CLI 백엔드 (codex / claude / agy)
 *
 * 기존 bridge.mjs 의 CLI 실행·이미지·영상 로직을 'provider 인터페이스'로 옮긴 것.
 *   provider = { id, label, capabilities:{text,image,video}, enabled(),
 *                runText({model,prompt,timeoutMs,extraArgs}),
 *                runImage?({prompt}), runVideo?({...}) }
 *
 * 저장 분리: 이미지/영상은 파일을 직접 쓰지 않고 '{buf, ext, mime}' 만 반환한다.
 *           실제 저장은 server-core 가 주입된 storage 로 일원화한다.
 *
 * 보안: 프롬프트는 쉘을 거치지 않고 spawn argv 로 전달(주입 불가). CLI 는 중립 임시 폴더에서 실행.
 *       claude 권한 우회(--dangerously-skip-permissions)는 BRIDGE_CLAUDE_SKIP_PERMS=1 일 때만.
 * ========================================================================== */

import { spawn } from "node:child_process";
import { readFile, writeFile, readdir, rm, mkdtemp, stat, symlink } from "node:fs/promises";
import { join, extname } from "node:path";
import os from "node:os";
import { detectImage, mimeForExt, VIDEO_EXTS } from "../../util.mjs";

const IS_WIN = process.platform === "win32";
const RUN_CWD = os.tmpdir();                                  // CLI 를 중립 디렉터리에서 실행(저장소 파일 안 읽게)
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS) || 240000;  // CLI 1회 실행 최대 대기(기본 4분)
const IMAGE_TIMEOUT_MS = Number(process.env.IMAGE_TIMEOUT_MS) || 600000;
const VIDEO_TIMEOUT_MS = Number(process.env.VIDEO_TIMEOUT_MS) || 600000;
const MEDIA_DL_TIMEOUT_MS = Number(process.env.MEDIA_DL_TIMEOUT_MS) || 120000;
const MAX_MEDIA_BYTES = Number(process.env.MAX_MEDIA_BYTES) || 256 * 1024 * 1024;
const MEDIA_HOST_ALLOWLIST = (process.env.MEDIA_HOST_ALLOWLIST || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const CLAUDE_SKIP_PERMS = /^(1|true|yes)$/i.test(process.env.BRIDGE_CLAUDE_SKIP_PERMS || "");

/* provider -> { cmd, args(model) }. 프롬프트는 항상 args 뒤에 push 된다(인자 전달). */
const CLI_DEFS = {
  codex:  { label: "Codex CLI (OpenAI)",     cmd: "codex",  args: (m) => ["exec", "--skip-git-repo-check", ...(m ? ["--model", m] : [])] },
  claude: { label: "Claude CLI (Anthropic)", cmd: "claude", args: (m) => ["-p", ...(CLAUDE_SKIP_PERMS ? ["--dangerously-skip-permissions"] : []), ...(m ? ["--model", m] : [])] },
  // agy: 모델 지정 시 프롬프트를 stdin 으로(실측 비대칭 동작 회피).
  agy:    { label: "Antigravity CLI",        cmd: "agy",    args: (m) => ["-p", ...(m ? ["--model=" + m] : [])], stdinPrompt: (m) => !!m },
};

/* ---- CLI 감지 -------------------------------------------------------------- */
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
  await Promise.all(Object.keys(CLI_DEFS).map(async (k) => { out[k] = await detect(CLI_DEFS[k].cmd); }));
  return out;
}

/* ---- 모델 목록 조회 -------------------------------------------------------- */
function shortCmd(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = "", err = "", done = false, child;
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
function codexTag(slug, idxFromTop) {
  const M = { "gpt-5.5": "최신·권장", "gpt-5.4": "이전 세대", "gpt-5.4-mini": "저렴·빠름", "gpt-5.3-codex": "코딩 특화", "gpt-5.2": "구형" };
  if (M[slug]) return M[slug];
  if (/mini|nano|lite|flash/i.test(slug)) return "저렴·빠름";
  if (/codex/i.test(slug)) return "코딩 특화";
  return idxFromTop === 0 ? "권장" : "";
}
async function listCodexModels() {
  const home = process.env.CODEX_HOME || join(os.homedir(), ".codex");
  const file = join(home, "models_cache.json");
  try {
    const data = JSON.parse(await readFile(file, "utf8"));
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
  const META = { flash: { name: "Gemini 3.5 Flash", tag: "가성비" }, pro: { name: "Gemini 3.1 Pro", tag: "고성능" }, flash_lite: { name: "Flash Lite", tag: "저렴" } };
  const r = await shortCmd("agy", ["--help"], 20000);
  const text = (r.out || "") + (r.err || "");
  const m = text.match(/--model=<([^>]+)>/);
  let tiers = m ? m[1].split("|").map((s) => s.trim()).filter(Boolean) : [];
  if (!tiers.length) tiers = ["flash", "pro", "flash_lite"];
  return { models: tiers.map((t) => ({ id: t, name: (META[t] && META[t].name) || t, tag: (META[t] && META[t].tag) || "" })), source: "agy --help" };
}
function listClaudeModels() {
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

/* ---- 이미지 생성 (agy / codex) — 저장 없이 {buf,ext,mime} 반환 ------------- */
const CODEX_IMG_DIR = join(process.env.CODEX_HOME || join(os.homedir(), ".codex"), "generated_images");
const IMAGE_PROVIDERS = {
  agy:   { args: (instr, model) => ["-p", ...(model ? ["--model=" + model] : []), instr] },
  codex: { args: (instr, model) => ["exec", "--skip-git-repo-check", ...(model ? ["--model", model] : []), instr], extraDir: CODEX_IMG_DIR },
};
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
// 콘텐츠 유형 → 목표 종횡비(세로형). 프론트 갤러리 박스(card/feed 4:5, story/reels 9:16) 및 API sizeForKind 와
// 정책을 맞춰, size 파라미터를 못 받는 codex/agy 내장 모델이 매번 제각각 비율로 내던 것을 프롬프트로 의도한 비율에 수렴시킨다.
// (CLI 모델은 픽셀 단위 고정이 불가능 → '비율 수렴'이 목표. 자연어 비율 지시는 모델명 힌트와 달리 NO_IMAGE_GEN 회귀와 무관.)
function aspectForKind(kind) {
  const k = String(kind || "").toLowerCase();
  if (k === "story" || k === "reels") return { ratio: "9:16", example: "1080x1920" };
  if (k === "card" || k === "feed") return { ratio: "4:5", example: "1080x1350" };
  return null; // misc 등 — 비율 강제 없이 모델 자유(기존 동작 유지)
}

// 생성된 이미지를 목표 비율·픽셀로 contain-pad 정규화(macOS 내장 sips). codex/agy 내장 모델이 비율 지시를
// 무시하므로(실측: codex 0.640~0.800, agy 1:1 정사각 — 프롬프트/aspect_ratio 구문/CLI 플래그/대화형 모두 무효) 생성
// 후처리로 강제 통일한다. crop 은 세로 긴 원본의 상/하단(제목·캡션)을 잘라 폐기하므로 → '축소 + 배경 평균색 pad'
// 로 잘림 0 보장(여백은 배경색이라 자연스럽게 섞임). sips 는 macOS 내장이라 npm 의존성 0 유지. 비-macOS·실패
// 시 null → 호출부가 원본 폴백(서버는 API 백엔드라 generateImage 미사용, sizeForKind 로 1024x1536 고정 → 무관).
function sipsRun(args) {
  return new Promise((res) => {
    let child;
    try { child = spawn("sips", args, { stdio: ["ignore", "ignore", "ignore"] }); }
    catch (_) { res(false); return; }
    child.on("error", () => res(false));
    child.on("close", (code) => res(code === 0));
  });
}
function sipsDims(path) {
  return new Promise((res) => {
    let out = "", child;
    try { child = spawn("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], { stdio: ["ignore", "pipe", "ignore"] }); }
    catch (_) { res(null); return; }
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.on("error", () => res(null));
    child.on("close", () => {
      const w = (out.match(/pixelWidth:\s*(\d+)/) || [])[1];
      const h = (out.match(/pixelHeight:\s*(\d+)/) || [])[1];
      res(w && h ? { w: parseInt(w, 10), h: parseInt(h, 10) } : null);
    });
  });
}
// 이미지 평균색(≈배경색) 추출 — sips 로 1x1 BMP 리샘플 후 픽셀 1개를 읽는다(의존성0). pad 여백을 이 색으로 채워
// 배경과 자연스럽게 잇는다. 실패 시 null → 호출부는 sips 기본(흰색) 폴백.
async function avgColorHex(path, scratchDir) {
  const bmpPath = join(scratchDir, "norm-px.bmp");
  const ok = await sipsRun(["-s", "format", "bmp", "-z", "1", "1", path, "--out", bmpPath]);
  if (!ok) return null;
  let d;
  try { d = await readFile(bmpPath); } catch (_) { return null; }
  try {
    const off = d.readUInt32LE(10);                        // BMP 헤더의 픽셀 데이터 오프셋
    if (off + 3 > d.length) return null;
    const b = d[off], g = d[off + 1], r = d[off + 2];      // BMP 픽셀은 BGR 순
    const hx = (n) => n.toString(16).padStart(2, "0").toUpperCase();
    return hx(r) + hx(g) + hx(b);
  } catch (_) { return null; }
}
async function normalizeAspect(buf, ar, scratchDir, ext) {
  if (process.platform !== "darwin") return null;          // sips 는 macOS 전용
  if (!ar || !ar.example) return null;                     // 비율 미지정(misc) → 정규화 안 함
  const m = /^(\d+)x(\d+)$/.exec(ar.example);
  if (!m) return null;
  const TW = parseInt(m[1], 10), TH = parseInt(m[2], 10);  // 목표 폭·높이
  const e = ext && ext.startsWith(".") ? ext : ("." + (ext || "png"));
  const inPath = join(scratchDir, "norm-in" + e);
  const outPath = join(scratchDir, "norm-out" + e);
  try { await writeFile(inPath, buf); } catch (_) { return null; }
  const dim = await sipsDims(inPath);
  if (!dim) return null;
  if (dim.w === TW && dim.h === TH) return null;            // 이미 목표 픽셀 → 원본 그대로
  // contain: 목표 안에 전부 들어가도록 한 변 기준 축소한 뒤, 남는 여백을 '배경 평균색'으로 pad(잘림 0 — 제목·캡션 보존).
  // 원본이 목표보다 가로로 넓으면 폭 기준 축소(→상하 여백), 세로로 길면 높이 기준 축소(→좌우 여백).
  const resample = (dim.w / dim.h > TW / TH) ? ["--resampleWidth", String(TW)] : ["--resampleHeight", String(TH)];
  const pad = await avgColorHex(inPath, scratchDir);
  const padArgs = pad ? ["--padColor", pad] : [];          // 추출 실패 시 sips 기본(흰색)
  const ok = await sipsRun([...resample, "--padToHeightWidth", String(TH), String(TW), ...padArgs, inPath, "--out", outPath]);
  if (!ok) return null;
  let outBuf;
  try { outBuf = await readFile(outPath); } catch (_) { return null; }
  const det = detectImage(outBuf);
  return det ? { buf: outBuf, ext: det.ext, mime: det.mime } : null;
}

async function generateImage(provider, prompt, model, imageModel, kind) {
  const def = IMAGE_PROVIDERS[provider] || IMAGE_PROVIDERS.agy;
  const cmd = provider === "codex" ? "codex" : "agy";
  const m = String(model || "").trim();
  const scratch = await mkdtemp(join(os.tmpdir(), "cm-img-"));
  const startedAt = Date.now() - 3000;
  let runHome = null, runEnv = process.env, extraDir = def.extraDir;
  if (provider === "codex") {
    const realHome = process.env.CODEX_HOME || join(os.homedir(), ".codex");
    runHome = await mkdtemp(join(os.tmpdir(), "cm-codexhome-"));
    for (const f of ["auth.json", "config.toml"]) { try { await symlink(join(realHome, f), join(runHome, f)); } catch (_) {} }
    runEnv = { ...process.env, CODEX_HOME: runHome };
    extraDir = join(runHome, "generated_images");
  }
  try {
    // 모델 힌트는 보내지 않는다: codex/agy 는 자체 내장 이미지 모델만 쓰고 API 모델명(gpt-image-1 등)을 못 고른다.
    // 힌트를 주면 일부 실행에서 'PREFERRED model 을 못 따른다'며 내장 모델로 폴백하지 않고 NO_IMAGE_GEN 으로
    // 즉시 포기하는 회귀가 있었다(imageModel 은 서버/API 백엔드에서만 의미 있음).
    const ar = aspectForKind(kind);
    const aspectLine = ar
      ? `Generate the image with aspect_ratio ${ar.ratio} (a vertical portrait, taller than wide), as one full-bleed ${ar.ratio} composition that fills the frame edge to edge with no borders or letterboxing. Compose with balanced spacing so the title and any caption sit comfortably inside the frame, not jammed against the very top or bottom edge. `
      : "";
    const instruction =
      aspectLine +
      "Use your built-in native image-generation model to directly generate ONE image from the prompt below, then save it as out.png in the current working directory. " +
      "CRITICAL: do NOT write or run any code or script (no Python, PIL, matplotlib, SVG, HTML, canvas) to draw it — you MUST produce the image with your image-generation model. " +
      "OUTPUT MUST BE ONE single finished, full-bleed composition that fills the entire frame as a real final artwork (one poster/one slide). " +
      "It is NOT a grid, collage, contact sheet, moodboard, storyboard, design-system board, style guide, template gallery, slideshow, mockup, or a set of multiple panels/thumbnails. " +
      "Any colors, hex codes, margins, or 'design system' notes in the prompt are STYLING GUIDANCE for that single artwork — never lay them out as labeled swatches or a board. Render the actual described scene/subject, on-topic, edge to edge. " +
      "If the prompt asks for on-image text, render that exact Korean text clearly and legibly with correct spelling (no fake or broken letters), and keep every line of text comfortably within the frame, not touching the very top or bottom edge. " +
      "Do not ask any questions. After saving, print only the saved file path. If you truly cannot generate an image, print exactly NO_IMAGE_GEN.\n\nThe image prompt is written in Korean:\n" + prompt;
    const result = await new Promise((res) => {
      let out = "", err = "", done = false, child;
      try { child = spawn(cmd, def.args(instruction, m), { cwd: scratch, stdio: ["ignore", "pipe", "pipe"], env: runEnv }); }
      catch (e) { res({ ok: false, error: cmd + " 실행 시작 실패: " + e.message }); return; }
      const fin = (o) => { if (done) return; done = true; clearTimeout(t); res(o); };
      const t = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch (_) {}
        const tail = [out && ("stdout: " + out.trim().slice(-500)), err && ("stderr: " + err.trim().slice(-500))].filter(Boolean).join(" / ");
        fin({ ok: false, error: `이미지 생성 시간 초과(${Math.round(IMAGE_TIMEOUT_MS / 1000)}s)` + (tail ? " · " + tail : "") });
      }, IMAGE_TIMEOUT_MS);
      child.stdout.on("data", (d) => { out += d.toString(); });
      child.stderr.on("data", (d) => { err += d.toString(); });
      child.on("error", (e) => fin({ ok: false, error: e.code === "ENOENT" ? (cmd + " CLI 를 찾을 수 없습니다(설치/PATH 확인).") : (cmd + " 실행 오류: " + e.message) }));
      child.on("close", () => fin({ ok: true, out, err }));
    });
    if (!result.ok) return result;
    let cands = await collectImages(scratch, 0, false);
    if (!cands.length && extraDir) cands = await collectImages(extraDir, startedAt, true);
    if (!cands.length) {
      const text = (result.out || "") + "\n" + (result.err || "");
      const snip = (result.out || "").trim().slice(0, 200);
      // 출력에 실제 한도 흔적(429·rate limit·quota 등)이 있을 때'만' 레이트리밋으로 표기(원인 단정 금지).
      if (/\b429\b|rate.?limit|too many requests|quota|insufficient_quota|over_capacity|temporarily unavailable/i.test(text)) {
        return { ok: false, rateLimited: true, error: "요청 한도(레이트리밋)에 걸렸습니다 — 잠시 후 다시 생성하세요." + (snip ? " 응답: " + snip : "") };
      }
      // NO_IMAGE_GEN = codex 가 '생성 불가'로 판단(정책 거부·일시 오류·포기 등). 원인을 단정하지 말고 사실 그대로 + 재시도 안내.
      const msg = /NO_IMAGE_GEN/.test(result.out || "")
        ? "codex 가 이 이미지를 생성하지 못했습니다(NO_IMAGE_GEN). 일시적 실패이거나 프롬프트가 정책에 걸렸을 수 있어요 — '다시 생성'으로 재시도하세요."
        : "이미지 파일을 찾지 못했습니다." + (snip ? " 응답: " + snip : "");
      return { ok: false, error: msg };
    }
    cands.sort((a, b) => b.buf.length - a.buf.length);
    const best = cands[0];
    // 목표 비율로 강제 정규화(sips cover-crop). 실패/비-macOS 면 원본 그대로.
    const norm = await normalizeAspect(best.buf, ar, scratch, "." + best.det.ext);
    if (norm) return { ok: true, buf: norm.buf, ext: norm.ext, mime: norm.mime };
    return { ok: true, buf: best.buf, ext: best.det.ext, mime: best.det.mime };
  } finally {
    rm(scratch, { recursive: true, force: true }).catch(() => {});
    if (runHome) rm(runHome, { recursive: true, force: true }).catch(() => {});
  }
}

/* ---- 영상 제작 (LLM CLI + MCP 영상 엔진) — 저장 없이 {buf,ext,videoUrl,...} -- */
const VIDEO_ENGINES = {
  higgsfield: { label: "Higgsfield", mcp: "higgsfield", defaultModel: "seedance_1_5", defaultImageModel: "nano_banana_pro" },
};
const CLAUDE_HIGGSFIELD_TOOLS = "--allowedTools=mcp__higgsfield__generate_image,mcp__higgsfield__generate_video,mcp__higgsfield__job_status,mcp__higgsfield__job_display,mcp__higgsfield__show_generations,mcp__higgsfield__reveal_generation,mcp__higgsfield__models_explore";

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
function parseResultJson(text) {
  const lines = String(text || "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const at = lines[i].indexOf("RESULT_JSON:");
    if (at < 0) continue;
    const raw = lines[i].slice(at + "RESULT_JSON:".length).trim();
    try { return JSON.parse(raw); } catch (_) {}
  }
  const m = String(text || "").match(/https:\/\/[^\s"')\]]+\.mp4[^\s"')\]]*/);
  if (m) return { ok: true, video_url: m[0], _fallback: true };
  return null;
}
// 모델이 돌려준 영상 URL 안전 검증(https + 내부/사설 차단 + 선택 allowlist → SSRF 방어).
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
// 원격 영상(엔진 CDN)을 내려받아 {buf,ext,mime} 반환(저장은 호출자/코어). 리디렉션 hop 마다 재검증.
async function downloadMedia(url) {
  let current = assertSafeMediaUrl(url);
  let resp;
  for (let hop = 0; hop < 4; hop++) {
    resp = await fetch(current, { signal: AbortSignal.timeout(MEDIA_DL_TIMEOUT_MS), redirect: "manual" });
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get("location");
      if (!loc) throw new Error("리디렉션 Location 헤더가 없습니다");
      current = assertSafeMediaUrl(new URL(loc, current));
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
  return { buf, ext, mime: mimeForExt(ext) };
}

/* ---- LLM CLI 1회 실행(기존 runCli) ---------------------------------------- */
function displayCommand(cmd, args, prompt) { return [cmd, ...args].join(" ") + ` "<프롬프트 ${prompt.length}자>"`; }

function runCli(def, model, prompt, timeoutMs, extraArgs) {
  const TO = timeoutMs || TIMEOUT_MS;
  return new Promise((resolve) => {
    const baseArgs = def.args(model);
    const extra = Array.isArray(extraArgs) ? extraArgs : [];
    const useStdin = typeof def.stdinPrompt === "function" && def.stdinPrompt(model);
    const args = useStdin ? [...baseArgs, ...extra] : [...baseArgs, ...extra, prompt];
    const command = displayCommand(def.cmd, [...baseArgs, ...extra], prompt);
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(def.cmd, args, { cwd: RUN_CWD, stdio: [useStdin ? "pipe" : "ignore", "pipe", "pipe"], env: process.env });
    } catch (e) {
      resolve({ ok: false, error: "CLI 실행 시작 실패: " + e.message, command });
      return;
    }
    if (useStdin) { try { child.stdin.write(prompt); child.stdin.end(); } catch (e) {} }
    let stdout = "", stderr = "", done = false;
    const finish = (obj) => { if (done) return; done = true; clearTimeout(timer); resolve(obj); };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch (_) {}
      finish({ ok: false, error: `시간 초과(${Math.round(TO / 1000)}s) — 실행을 중단했습니다.`, command, stderr, durationMs: Date.now() - startedAt });
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
        ok: code === 0, code, output: stdout, stderr, command,
        durationMs: Date.now() - startedAt,
        error: code === 0 ? undefined : `CLI 가 0이 아닌 코드(${code})로 종료되었습니다.`,
      });
    });
  });
}

// 영상 1컷: instruction 생성 → CLI(MCP) 실행 → RESULT_JSON 파싱 → 원격 mp4 다운로드(→buf). 저장은 코어.
async function runVideoCli(provider, o) {
  const eng = VIDEO_ENGINES[String(o.engine || "higgsfield")];
  if (!eng) return { ok: false, error: "지원하지 않는 영상 엔진: " + o.engine };
  const instruction = buildVideoInstruction(eng, o);
  const extraArgs = provider === "claude" ? [CLAUDE_HIGGSFIELD_TOOLS] : [];
  const run = await runCli(CLI_DEFS[provider], String(o.model || "").trim(), instruction, VIDEO_TIMEOUT_MS, extraArgs);
  if (!run.ok && !run.output) return { ok: false, error: run.error || "CLI 실행 실패", stderr: (run.stderr || "").slice(-600) };
  const parsed = parseResultJson(run.output || "");
  if (!parsed) return { ok: false, error: "영상 결과(RESULT_JSON)를 찾지 못했습니다. 크레딧 부족이나 엔진 오류일 수 있어요(아래 raw 확인). 또는 CLI 의 MCP 영상 엔진 연결을 점검하세요.", raw: (run.output || "").slice(-600) };
  if (parsed.ok === false) return { ok: false, error: parsed.error || "영상 엔진이 생성에 실패했습니다.", raw: (run.output || "").slice(-400) };
  const videoUrl = (parsed.video_url || "").toString().trim();
  if (!videoUrl) return { ok: false, error: "영상 URL 이 비어 있습니다.", raw: (run.output || "").slice(-400) };
  let media = null, saveError = null;
  try { media = await downloadMedia(videoUrl); } catch (e) { saveError = e.message; }
  return {
    ok: true, videoUrl,
    buf: media ? media.buf : null, ext: media ? media.ext : ".mp4", mime: media ? media.mime : "video/mp4",
    saveError,
    imageUrl: (parsed.image_url || "").toString() || null,
    imageJobId: (parsed.image_job_id || "").toString() || null,
    videoJobId: (parsed.video_job_id || "").toString() || null,
  };
}

/* ---- provider 인터페이스 조립 --------------------------------------------- */
export async function makeCliBackend(_env) {
  const mk = (id, caps) => ({
    id, label: CLI_DEFS[id].label, capabilities: caps,
    enabled: () => detect(CLI_DEFS[id].cmd),
    runText: (a) => runCli(CLI_DEFS[id], (a.model || "").trim(), a.prompt, a.timeoutMs, a.extraArgs),
    runImage: caps.image ? (a) => generateImage(id, a.prompt, a.model, a.imageModel, a.kind) : null,
    runVideo: caps.video ? (a) => runVideoCli(id, a) : null,
  });
  const providers = {
    codex:  mk("codex",  { text: true, image: true,  video: true }),
    claude: mk("claude", { text: true, image: false, video: true }),
    agy:    mk("agy",    { text: true, image: true,  video: false }),
  };
  return { kind: "cli", providers, detectAll, listModels: listModelsAll };
}
