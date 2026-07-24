/** Narrow filetype-aware serialization port for durable document projections. */
import { DocumentSyncError, type MarkdownDocumentEngine } from "../markdown-document.js";

export type DurableProjectionSerializer = Pick<MarkdownDocumentEngine, "serializeDocument">;

export function isCorruptDurableProjectionError(
  cause: unknown,
): cause is DocumentSyncError & { code: "corrupt_state" } {
  return cause instanceof DocumentSyncError && cause.code === "corrupt_state";
}
