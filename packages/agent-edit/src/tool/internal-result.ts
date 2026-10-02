// Defines internal write-tool result envelopes beneath the public WriteOutcome API.

import { type AgentEditModelPayload, isWriteStatus } from "./model-result.js";
import type {
  DocumentCommandName,
  WriteErrorDetail,
  WriteStatus,
  WriteSuccessPhase,
} from "./types.js";

export type InternalWriteResult = InternalWriteResultBase &
  ({ status: "success"; phase: WriteSuccessPhase } | { status: Exclude<WriteStatus, "success"> });

interface InternalWriteResultBase {
  revision?: string | null;
  model?: AgentEditModelPayload;
  writeId?: string;
  settlementId?: string;
  error?: WriteErrorDetail;
}

export function documentNotFound(
  commandName: DocumentCommandName,
  filePath: string,
): InternalWriteResult {
  if (commandName === "read") {
    return status(
      "document_not_found",
      `File not found. Check the path, or use write(command="create", path="${filePath}") to make a new one.`,
    );
  }
  return status("document_not_found", "File not found. Read the project to find the right path.");
}

export function isInternalWriteResult(value: unknown): value is InternalWriteResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    isWriteStatus((value as { status: unknown }).status)
  );
}

/** An internal failure that must abort the caller, carrying the model-facing message. */
export function internalResultError(result: InternalWriteResult): Error {
  return new Error(
    result.model?.message ? `${result.status}: ${result.model.message}` : result.status,
  );
}

function status(code: Exclude<WriteStatus, "success">, message?: string): InternalWriteResult {
  return { status: code, ...(message ? { model: { message } } : {}) };
}
