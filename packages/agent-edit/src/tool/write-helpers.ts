import { EDIT_FAILED_MESSAGE } from "../apply/types.js";
import type { DocumentAddress } from "../document-address.js";
import { parseDocumentAddress } from "../document-address.js";
import { isDocumentNotFoundError } from "../ports/document-rooms.js";
import { writeCommandName } from "./command-schema.js";
import type { RenderedRead } from "./document-renderer.js";
import { documentNotFound, type InternalWriteResult } from "./internal-result.js";
import type { AgentEditResultCommand } from "./model-result.js";
import { status } from "./response-format.js";
import type { DocumentCommandName, WriteErrorStatus } from "./types.js";

let nextAutoTurnIdNonce = 0;

export function createAutoTurnIdNonce(): string {
  nextAutoTurnIdNonce += 1;
  const instanceId = nextAutoTurnIdNonce.toString(36);
  const randomId =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${instanceId}-${randomId}`;
}

export function parseFileAddress(command: {
  file: string;
  documentId?: string;
}): ({ ok: true } & DocumentAddress) | { ok: false; message: string } {
  return parseDocumentAddress(command.file, command.documentId);
}

export function errorResponse(
  code: WriteErrorStatus,
  message: string,
  filePath: string,
  documentBlocks?: number,
): InternalWriteResult {
  if (documentBlocks !== undefined) {
    return status(
      code,
      `${message}. ${filePath} has ${documentBlocks === 1 ? "1 block" : `${documentBlocks} blocks`}.`,
    );
  }
  return status(code, message);
}

export function readSuccess(read: RenderedRead): InternalWriteResult {
  return {
    status: "success",
    model: {
      read: { format: read.format, documentBlocks: read.documentBlocks },
      blocks:
        read.blocks.length > 0
          ? [
              {
                extent: "full",
                relation: "document",
                items: read.blocks,
              },
            ]
          : [],
    },
  };
}

export function writeError(cause: unknown, commandName: DocumentCommandName): InternalWriteResult {
  if (isDocumentNotFoundError(cause)) return documentNotFound(commandName, cause);
  return status("internal_error", EDIT_FAILED_MESSAGE);
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function fallbackCommandName(command: unknown): AgentEditResultCommand {
  return writeCommandName(command) ?? "unknown";
}

export function writeSchemaError(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `${path}${issue.message}`;
    })
    .join("; ");
}
