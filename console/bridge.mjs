#!/usr/bin/env node
/* ============================================================================
 * bridge.mjs — 로컬 LLM CLI 브리지 (Node 18+ 내장 모듈만, 의존성 0)
 *
 * 역할: 브라우저 콘솔(content-orchestrator.html)이 보낸 프롬프트를 받아,
 *       로컬에 설치된 LLM CLI(codex / claude / gemini)를 터미널에서 실행하고
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
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import os from "node:os";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT) || 8787;
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS) || 240000; // CLI 1회 실행 최대 대기(기본 4분)
const MAX_BODY = 4 * 1024 * 1024;                            // 요청 본문 최대 4MB
const HTML_FILE = "content-orchestrator.html";
const __dir = dirname(fileURLToPath(import.meta.url));
const RUN_CWD = os.tmpdir();                                 // CLI 를 중립 디렉터리에서 실행(저장소 파일 안 읽게)
const IS_WIN = process.platform === "win32";

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
  gemini: { cmd: "gemini", args: (m) => [...(m ? ["-m", m] : []), "-p"] },
};

/* ---- 유틸 ---------------------------------------------------------------- */

function setCors(req, res) {
  const origin = req.headers.origin;
  // 로컬 전용: 요청 Origin 을 그대로 반사(없으면 *). 자격증명은 쓰지 않음.
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
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

/* LLM CLI 1회 실행 (프롬프트는 argv 마지막, stdin 무시) */
function runCli(provider, model, prompt) {
  return new Promise((resolve) => {
    const def = PROVIDERS[provider];
    const args = [...def.args(model), prompt];
    const command = displayCommand(def.cmd, def.args(model), prompt);
    const startedAt = Date.now();

    let child;
    try {
      child = spawn(def.cmd, args, {
        cwd: RUN_CWD,
        stdio: ["ignore", "pipe", "pipe"],   // stdin 무시 → Codex non-TTY 파이프 무한대기 회피
        env: process.env,
      });
    } catch (e) {
      resolve({ ok: false, error: "CLI 실행 시작 실패: " + e.message, command });
      return;
    }

    let stdout = "", stderr = "", done = false;
    const finish = (obj) => { if (done) return; done = true; clearTimeout(timer); resolve(obj); };

    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch (_) {}
      finish({ ok: false, error: `시간 초과(${Math.round(TIMEOUT_MS/1000)}s) — 실행을 중단했습니다.`, command, stderr, durationMs: Date.now() - startedAt });
    }, TIMEOUT_MS);

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
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
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

  // CLI 실행
  if (req.method === "POST" && path === "/run") {
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
  console.log("   종료: Ctrl+C");
  console.log("──────────────────────────────────────────────");
});
