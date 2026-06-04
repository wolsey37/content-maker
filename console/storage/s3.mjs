/* ============================================================================
 * storage/s3.mjs — AWS S3 저장소 (미디어 + 작업 JSON)
 *
 * 미디어: PutObject 로 올리고, 표시용 URL 은 presigned GET(만료 있음)을 '읽을 때마다' 새로 발급.
 *         → 영속(작업 JSON)에는 만료 없는 'key' 만 저장하고, 열 때 urlFor(key) 로 fresh URL 을 만든다.
 * 작업(JSON): jobs/... 키로 put/get/list/delete.
 *
 * SDK: @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner.
 *   - 배포된 Lambda(Node 18/20) 런타임에 동봉되지만 버전이 바뀔 수 있어 아티팩트에 번들 권장.
 *   - 로컬 STORAGE=s3 테스트 시에는 devDependency 로 설치 필요.
 *   - 이 모듈은 index.mjs 에서 STORAGE=s3 일 때만 동적 import 되므로, 로컬 모드(local)에선 로드되지 않는다(의존성 0 유지).
 * ========================================================================== */

import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export function makeS3Storage(env) {
  env = env || process.env;
  const Bucket = env.S3_BUCKET;
  if (!Bucket) throw new Error("S3_BUCKET 환경변수가 필요합니다(STORAGE=s3).");
  const prefix = String(env.S3_PREFIX || "").replace(/^\/+|\/+$/g, "");
  const region = env.S3_REGION || env.AWS_REGION || undefined;
  const TTL = Number(env.S3_URL_TTL) || 3600;   // presigned GET 만료(초)
  const client = new S3Client(region ? { region } : {});

  const clean = (k) => String(k).replace(/^\/+|\/+$/g, "");
  const full = (k) => (prefix ? prefix + "/" + clean(k) : clean(k));

  async function urlFor(key) {
    return getSignedUrl(client, new GetObjectCommand({ Bucket, Key: full(key) }), { expiresIn: TTL });
  }
  async function save(key, buf, mime) {
    await client.send(new PutObjectCommand({ Bucket, Key: full(key), Body: buf, ContentType: mime }));
    return { key: clean(key), url: await urlFor(key) };
  }
  async function putJson(key, obj) {
    await client.send(new PutObjectCommand({ Bucket, Key: full(key), Body: JSON.stringify(obj), ContentType: "application/json" }));
  }
  async function getJson(key) {
    try {
      const r = await client.send(new GetObjectCommand({ Bucket, Key: full(key) }));
      return JSON.parse(await r.Body.transformToString());
    } catch (e) {
      if (e && (e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404)) return null;
      throw e;
    }
  }
  async function list(prefixKey) {
    const Prefix = full(prefixKey);
    const out = [];
    let token;
    do {
      const r = await client.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken: token }));
      for (const o of (r.Contents || [])) {
        const key = prefix ? o.Key.slice(prefix.length + 1) : o.Key;   // 내부 prefix 벗겨 호출자 관점 key 로
        out.push({ key, size: o.Size, mtimeMs: o.LastModified ? +o.LastModified : 0 });
      }
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
  }
  async function del(key) { await client.send(new DeleteObjectCommand({ Bucket, Key: full(key) })); }

  // s3 미디어는 presigned URL 로 직접 접근하므로 readMedia(정적 서빙) 는 제공하지 않는다.
  return { kind: "s3", save, urlFor, putJson, getJson, list, del };
}
