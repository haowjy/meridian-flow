/** Narrow filetype-aware serialization port for durable document projections. */
import type { MarkdownDocumentEngine } from "../markdown-document.js";

export type DurableProjectionSerializer = Pick<MarkdownDocumentEngine, "serializeDocument">;

export function isCorruptDurableProjectionError(
  cause: unknown,
): cause is Error & { code: "corrupt_state" } {
  return (
    cause instanceof Error &&
    "code" in cause &&
    (cause as { code?: unknown }).code === "corrupt_state"
  );
}
