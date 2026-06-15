/**
 * Read-tool presentation policy: byte-safe truncation and line-number formatting.
 * The policy is pure so adapter-backed read handlers can stay as thin wiring.
 */
export const MAX_READ_BYTES = 1024 * 1024;
export const TRUNCATION_MARKER = "\n\n[... content truncated at 1MB ...]";

export function formatWithLineNumbers(content: string): string {
  return content
    .split("\n")
    .map((line, index) => `${index + 1}|${line}`)
    .join("\n");
}

/**
 * Truncate a string to fit within MAX_READ_BYTES, respecting UTF-8 boundaries.
 *
 * Backtracks character-by-character from the end, checking the byte length
 * after each trim, so the result never slices a multi-byte UTF-8 character
 * in half. The truncation marker's byte length is subtracted from the limit
 * first so the marker + truncated content fits exactly.
 */
export function truncateForRead(content: string): string {
  if (Buffer.byteLength(content, "utf8") <= MAX_READ_BYTES) {
    return content;
  }
  let truncated = content;
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  const limit = MAX_READ_BYTES - markerBytes;
  while (truncated.length > 0 && Buffer.byteLength(truncated, "utf8") > limit) {
    truncated = truncated.slice(0, -1);
  }
  return truncated + TRUNCATION_MARKER;
}
