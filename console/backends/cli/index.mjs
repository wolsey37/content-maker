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
import { readFile, readdir, rm, mkdtemp, stat, symlink } from "node:fs/promises";
import { join, extname } from "node:path";
import os from "node:os";
import { detectImage, mimeForExt, VIDEO_EXTS } from "../../util.mjs";

const IS_WIN = process.platform === "win32";
const RUN_CWD = os.tmpdir();                                  // CLI 를 중립 디렉터리에서 실행(저장소 파일 안 읽게)
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS) || 240000;  // CLI 1회 실행 최대 대기(기본 4분)
const IMAGE_TIMEOUT_MS = Number(process.env.IMAGE_TIMEOUT_MS) || 180000;
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
  agy:   { args: (instr) => ["-p", instr] },
  codex: { args: (instr) => ["exec", "--skip-git-repo-check", instr], extraDir: CODEX_IMG_DIR },
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
async function generateImage(provider, prompt) {
  const def = IMAGE_PROVIDERS[provider] || IMAGE_PROVIDERS.agy;
  const cmd = provider === "codex" ? "codex" : "agy";
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
    const instruction =
      "Use your built-in native image-generation model to directly generate ONE image from the prompt below, then save it as out.png in the current working directory. " +
      "CRITICAL: do NOT write or run any code or script (no Python, PIL, matplotlib, SVG, HTML, canvas) to draw it — you MUST produce the image with your image-generation model. " +
      "OUTPUT MUST BE ONE single finished, full-bleed composition that fills the entire frame as a real final artwork (one poster/one slide). " +
      "It is NOT a grid, collage, contact sheet, moodboard, storyboard, design-system board, style guide, template gallery, slideshow, mockup, or a set of multiple panels/thumbnails. " +
      "Any colors, hex codes, margins, or 'design system' notes in the prompt are STYLING GUIDANCE for that single artwork — never lay them out as labeled swatches or a board. Render the actual described scene/subject, on-topic, edge to edge. " +
      "If the prompt asks for on-image text, render that exact Korean text clearly and legibly with correct spelling (no fake or broken letters). " +
      "Do not ask any questions. After saving, print only the saved file path. If you truly cannot generate an image, print exactly NO_IMAGE_GEN.\n\nThe image prompt is written in Korean:\n" + prompt;
    const result = await new Promise((res) => {
      let out = "", err = "", done = false, child;
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
    let cands = await collectImages(scratch, 0, false);
    if (!cands.length && extraDir) cands = await collectImages(extraDir, startedAt, true);
    if (!cands.length) {
      const snip = (result.out || "").trim().slice(0, 200);
      return { ok: false, error: "이미지 파일을 찾지 못했습니다." + (snip ? " 응답: " + snip : "") };
    }
    cands.sort((a, b) => b.buf.length - a.buf.length);
    const best = cands[0];
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
    runImage: caps.image ? (a) => generateImage(id, a.prompt) : null,
    runVideo: caps.video ? (a) => runVideoCli(id, a) : null,
  });
  const providers = {
    codex:  mk("codex",  { text: true, image: true,  video: true }),
    claude: mk("claude", { text: true, image: false, video: true }),
    agy:    mk("agy",    { text: true, image: true,  video: false }),
  };
  return { kind: "cli", providers, detectAll, listModels: listModelsAll };
}
