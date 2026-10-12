// Defines internal write-tool result envelopes beneath the public WriteOutcome API.

import type { Block } from "../codec-types.js";
import type { LinkShowing } from "../links/shown.js";
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
  /** Host-only: what the rendered result showed the model. */
  showing?: LinkShowing;
  /** The blocks a read selected, for a host copying them. */
  nodes?: readonly Block[];
  model?: AgentEditModelPayload;
  writeId?: string;
  settlementId?: string;
  error?: WriteErrorDetail;
}

export function documentNotFound(commandName: DocumentCommandName): InternalWriteResult {
  return status("document_not_found", documentNotFoundMessage(commandName));
}

/** The one sentence every missing-document result gives the model. */
export function documentNotFoundMessage(commandName: DocumentCommandName): string {
  return commandName === "read"
    ? "File not found. Check the path with `ls`."
    : "File not found. Read the project to find the right path.";
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
