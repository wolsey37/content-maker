/* ============================================================================
 * storage/index.mjs — STORAGE env 로 저장소 어댑터 선택
 *
 *   STORAGE=local (기본) → 디스크(output/). 의존성 0.
 *   STORAGE=s3            → AWS S3. s3.mjs 를 '동적 import' 하므로 local 모드에선 aws-sdk 를 로드하지 않는다.
 *
 * 어댑터 공통 인터페이스:
 *   save(key, buf, mime) → { key, url }   // key=영속용(만료 없음), url=즉시 표시용
 *   urlFor(key)          → url            // 읽을 때 fresh url (s3=presigned, local=상대경로)
 *   putJson/getJson/list/del              // 작업(JSON) 객체 CRUD
 *   (local 전용) readMedia(key) → { buf, mime }   // 정적 서빙용
 * ========================================================================== */

export async function createStorage(env) {
  env = env || process.env;
  const kind = String(env.STORAGE || "local").toLowerCase();
  if (kind === "s3") {
    const { makeS3Storage } = await import("./s3.mjs");
    return makeS3Storage(env);
  }
  const { makeLocalStorage } = await import("./local.mjs");
  return makeLocalStorage(env);
}
