/** Narrow filetype-aware serialization port for durable document projections. */
import type { MarkdownDocumentEngine } from "../markdown-document.js";

export type DurableProjectionSerializer = Pick<MarkdownDocumentEngine, "serializeDocument">;

export class DurableProjectionSerializationError extends Error {
  readonly code = "corrupt_state";

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "DurableProjectionSerializationError";
  }
}
