/* ============================================================================
 * storage/local.mjs — 로컬 디스크 저장소(기존 output/ 동작 보존, 의존성 0)
 *
 * 미디어: output/<key> 에 저장하고 상대 URL("/output/<key>")을 돌려준다.
 *         로컬 URL 은 만료가 없으므로 key === '/output/'+key 의 안정 참조.
 * 작업(JSON): output/jobs/... 에 평문 JSON 으로 저장(/output 정적 서빙은 미디어 확장자만 허용 → JSON 비노출).
 * ========================================================================== */

import { mkdir, writeFile, readFile, readdir, rm, stat } from "node:fs/promises";
import { join, resolve, dirname, extname, sep } from "node:path";
import { mimeForExt } from "../util.mjs";

export function makeLocalStorage(env) {
  env = env || process.env;
  const OUTPUT_DIR = resolve(env.OUTPUT_DIR || join(process.cwd(), "output"));

  // key 가 OUTPUT_DIR 를 벗어나지 못하게(path traversal 차단) 절대경로로 정규화.
  function abs(key) {
    const rel = String(key).replace(/^\/+/, "");
    const p = resolve(OUTPUT_DIR, rel);
    if (p !== OUTPUT_DIR && !p.startsWith(OUTPUT_DIR + sep)) throw new Error("잘못된 저장 키: " + key);
    return p;
  }
  const clean = (k) => String(k).replace(/^\/+|\/+$/g, "");

  async function save(key, buf, _mime) {
    const a = abs(key);
    await mkdir(dirname(a), { recursive: true });
    await writeFile(a, buf);
    return { key: clean(key), url: "/output/" + clean(key) };
  }
  // 로컬은 만료 없는 상대경로 — 저장 때와 동일한 URL.
  function urlFor(key) { return "/output/" + clean(key); }

  // 정적 서빙용(서버 코어가 GET /output/* 에서 호출).
  async function readMedia(key) {
    const a = abs(key);
    const buf = await readFile(a);
    return { buf, mime: mimeForExt(extname(a)) };
  }

  async function putJson(key, obj) {
    const a = abs(key);
    await mkdir(dirname(a), { recursive: true });
    await writeFile(a, JSON.stringify(obj));
  }
  async function getJson(key) {
    try { return JSON.parse(await readFile(abs(key), "utf8")); }
    catch (e) { if (e.code === "ENOENT") return null; throw e; }
  }
  // prefix(예: "jobs/") 하위의 파일을 재귀 나열 → [{ key, size, mtimeMs }]
  async function list(prefix) {
    const cp = clean(prefix);
    const base = abs(cp);
    let names;
    try { names = await readdir(base, { recursive: true }); }
    catch (e) { if (e.code === "ENOENT") return []; throw e; }
    const out = [];
    for (const name of names) {
      const full = join(base, name);
      let s;
      try { s = await stat(full); } catch { continue; }
      if (!s.isFile()) continue;
      out.push({ key: (cp + "/" + String(name).split(sep).join("/")), size: s.size, mtimeMs: s.mtimeMs });
    }
    return out;
  }
  async function del(key) { await rm(abs(key), { force: true }); }

  return { kind: "local", outputDir: OUTPUT_DIR, save, urlFor, readMedia, putJson, getJson, list, del };
}
