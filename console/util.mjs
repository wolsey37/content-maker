/* ============================================================================
 * util.mjs — 백엔드/스토리지 공용 헬퍼 (확장자·MIME·이미지 매직바이트)
 *   bridge.mjs 에 흩어져 있던 미디어 판별 유틸을 한곳에 모았다(의존성 0).
 * ========================================================================== */

export const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
export const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov", ".m4v"]);
export const MEDIA_EXTS = new Set([...IMAGE_EXTS, ...VIDEO_EXTS]);   // 정적 서빙 허용 확장자(이미지+영상)

// 매직바이트로 실제 이미지 형식 판별(확장자가 형식과 달라도 정확). 이미지가 아니면 null.
export function detectImage(buf) {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: "png", mime: "image/png" };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return { ext: "webp", mime: "image/webp" };
  if (buf.length >= 4 && buf.toString("ascii", 0, 4) === "GIF8") return { ext: "gif", mime: "image/gif" };
  return null;
}

export function mimeForExt(ext) {
  return ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
    ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".m4v": "video/x-m4v" })[String(ext).toLowerCase()] || "application/octet-stream";
}
