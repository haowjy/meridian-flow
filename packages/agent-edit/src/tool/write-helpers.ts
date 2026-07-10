// Shared parsing, identity, and error helpers for the write command pipeline.
import type { ConcurrentUpdateOrigin } from "../apply/types.js";
import type { DocumentAddress } from "../document-address.js";
import { parseDocumentAddress } from "../document-address.js";
import type { UpdateMeta } from "../ports/types.js";
import { BaselineIntegrationError } from "./interaction-mode.js";
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

export function parseFileAddress(
  command: Pick<WriteCommand, "file" | "documentId">,
): ({ ok: true } & DocumentAddress) | { ok: false; message: string } {
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

export function readSuccess(text: string): InternalWriteResult {
  return result("success", text, { phase: "committed" });
}

export function writeError(cause: unknown): InternalWriteResult {
  if (isResponseLifecycleError(cause)) {
    return status("invalid_write", cause.message, { error: cause.detail });
  }
  if (cause instanceof BaselineIntegrationError) {
    return status("internal_error", cause.message);
  }
  return status("internal_error", "Retry — transient edit system failure.");
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function agentMeta(turnId: string): UpdateMeta {
  return { origin: `agent:${turnId}`, actorTurnId: turnId, seq: 0 };
}

export function agentUpdateOrigin(turnId: string): ConcurrentUpdateOrigin & { type: "agent" } {
  return { type: "agent", actorTurnId: turnId };
}

export function mutationMeta(actor: MutationActor): UpdateMeta {
  if (actor.kind === "agent") return agentMeta(actor.turnId);
  if (actor.kind === "human") return { origin: `human:${actor.userId}`, seq: 0 };
  return { origin: `system:${actor.origin}`, seq: 0 };
}

export function mutationUpdateOrigin(actor: MutationActor): ConcurrentUpdateOrigin {
  if (actor.kind === "agent") return agentUpdateOrigin(actor.turnId);
  if (actor.kind === "human") return { type: "human", userId: actor.userId };
  return { type: "system" };
}

export function fallbackCommandName(command: unknown): WriteCommand["command"] {
  if (typeof command === "object" && command !== null && "command" in command) {
    const value = (command as { command?: unknown }).command;
    switch (value) {
      case "create":
      case "read":
      case "insert":
      case "replace":
      case "undo":
      case "redo":
        return value;
    }
  }
  return "read";
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

export function isUnconfirmedDestructiveReplace(
  command: Extract<WriteCommand, { command: "insert" | "replace" }>,
  address: DocumentAddress,
): boolean {
  return (
    command.command === "replace" &&
    command.find === undefined &&
    (command.in !== undefined || address.fragment !== undefined)
  );
}
