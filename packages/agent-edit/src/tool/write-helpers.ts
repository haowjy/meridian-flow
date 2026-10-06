// Shared parsing, identity, and error helpers for the write command pipeline.
import type { ConcurrentUpdateOrigin } from "../apply/types.js";
import type { DocumentAddress } from "../document-address.js";
import { parseDocumentAddress } from "../document-address.js";
import type { UpdateMeta } from "../ports/types.js";
import { writeCommandName } from "./command-schema.js";
import type { RenderedRead } from "./document-renderer.js";
import type { InternalWriteResult } from "./internal-result.js";
import type { AgentEditResultCommand } from "./model-result.js";
import { isResponseLifecycleError } from "./response-committer.js";
import { status } from "./response-format.js";
import { readCall } from "./result-text.js";
import type { MutationActor, WriteErrorStatus } from "./types.js";

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

/**
 * A `not_found` points at a re-read, since the model's hashes are stale,
 * unless its message already names the read to make. A block number past the
 * end isn't stale, so it gets the document's size.
 */
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
  const needsRead = code === "not_found" && !/\bread\b/.test(message);
  const sentence = message.replace(/\.$/, "");
  return status(code, needsRead ? `${sentence}. Run ${readCall(filePath)} to re-sync.` : message);
}

export function readSuccess(read: RenderedRead): InternalWriteResult {
  return {
    status: "success",
    phase: "committed",
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

export function writeError(cause: unknown): InternalWriteResult {
  if (isResponseLifecycleError(cause)) {
    return status("invalid_write", cause.message, { error: cause.detail });
  }
  return status("internal_error", "Retry — transient edit system failure.");
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function agentMeta(turnId: string, editScopeId?: string): UpdateMeta {
  return {
    origin: `agent:${turnId}`,
    actorTurnId: turnId,
    seq: 0,
    ...(editScopeId ? { editScopeId } : {}),
  };
}

export function agentUpdateOrigin(turnId: string): ConcurrentUpdateOrigin & { type: "agent" } {
  return { type: "agent", actorTurnId: turnId };
}

export function mutationMeta(actor: MutationActor): UpdateMeta {
  if (actor.kind === "agent") return agentMeta(actor.turnId, actor.responseId);
  if (actor.kind === "human") return { origin: `human:${actor.userId}`, seq: 0 };
  return { origin: `system:${actor.origin}`, seq: 0 };
}

export function mutationUpdateOrigin(actor: MutationActor): ConcurrentUpdateOrigin {
  if (actor.kind === "agent") return agentUpdateOrigin(actor.turnId);
  if (actor.kind === "human") return { type: "human", userId: actor.userId };
  return { type: "system" };
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
