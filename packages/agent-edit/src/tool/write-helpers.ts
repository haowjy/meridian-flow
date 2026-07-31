// Shared parsing, identity, and error helpers for the write command pipeline.
import type { ConcurrentUpdateOrigin } from "../apply/types.js";
import type { DocumentAddress } from "../document-address.js";
import { parseDocumentAddress } from "../document-address.js";
import type { UpdateMeta } from "../ports/types.js";
import { writeCommandName } from "./command-schema.js";
import type { RenderedRead } from "./document-renderer.js";
import type { InternalWriteResult } from "./internal-result.js";
import { isResponseLifecycleError } from "./response-committer.js";
import { result, status } from "./response-format.js";
import type { MutationActor, WriteCommand, WriteErrorStatus } from "./types.js";

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
): InternalWriteResult {
  const needsRead = code === "not_found" && !message.includes('write(command="read"');
  return status(
    code,
    needsRead ? `${message}. Run write(command="read", file="${filePath}") to re-sync.` : message,
  );
}

export function readSuccess(read: RenderedRead): InternalWriteResult {
  return result("success", read.text, {
    phase: "committed",
    model: {
      read: { format: read.format },
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
  });
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

export function agentMeta(turnId: string, authoringResponseId?: string): UpdateMeta {
  return {
    origin: `agent:${turnId}`,
    actorTurnId: turnId,
    seq: 0,
    ...(authoringResponseId ? { authoringResponseId } : {}),
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

export function fallbackCommandName(command: unknown): WriteCommand["command"] {
  return writeCommandName(command) ?? "read";
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
