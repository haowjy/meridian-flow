// Shared formatting and parsing helpers for the write command pipeline.
import * as Y from "yjs";

import { truncateSerializedBlock } from "../apply/echo.js";
import type { ApplyEchoHunk, ConcurrentEditInfo, ConcurrentUpdateOrigin } from "../apply/types.js";
import type { DocumentAddress } from "../document-address.js";
import { parseDocumentAddress } from "../document-address.js";
import type { DocHandle } from "../handles.js";
import type { UpdateMeta } from "../ports/types.js";
import { parseWriteHandle } from "../ports/update-journal.js";
import type { ReversalSelection } from "../undo/reversal-plan.js";
import type { InternalWriteResult, WriteResultBlock } from "./internal-result.js";
import { isResponseLifecycleError } from "./response-committer.js";
import { formatConcurrent, result, status } from "./response-format.js";
import type {
  RedoCommand,
  UndoCommand,
  WriteCommand,
  WriteErrorStatus,
  WriteSuccessPhase,
} from "./types.js";

export interface ApplySuccessResponseInput {
  phase: WriteSuccessPhase;
  writeId?: string;
  echo: ApplyEchoHunk[];
  concurrentEdits?: ConcurrentEditInfo;
  deletedBlocks?: readonly string[];
}

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

export function formatApplySuccess(input: ApplySuccessResponseInput): InternalWriteResult {
  const metaLines = ["status: success"];
  if (input.writeId) metaLines.push(`write id: ${input.writeId}`);
  if (input.deletedBlocks && input.deletedBlocks.length > 0) {
    metaLines.push(`deleted: ${input.deletedBlocks.join(", ")}`);
  }
  const echoLines = input.echo.flatMap((hunk) => hunk.blocks).filter((line) => line.length > 0);
  if (input.concurrentEdits) {
    metaLines.push(
      ...formatConcurrent(input.concurrentEdits, {
        excludeHashes: blockHashes(
          input.echo
            .filter((hunk) => hunk.mode === "full")
            .flatMap((hunk) => hunk.blocks)
            .filter((line) => line.length > 0),
        ),
      }),
    );
  }

  const content: WriteResultBlock[] = [{ type: "text", text: metaLines.join("\n") }];
  if (echoLines.length > 0) content.push({ type: "text", text: echoLines.join("\n") });

  return {
    status: "success",
    phase: input.phase,
    text: content.map((block) => block.text).join("\n\n"),
    content,
    ...(input.writeId ? { writeId: input.writeId } : {}),
  };
}

export function truncateCreateEcho(
  renderer: { renderBlockLines: (doc: DocHandle) => string[] },
  doc: Y.Doc,
  toDocHandle: (doc: Y.Doc) => DocHandle,
): string[] {
  return renderer.renderBlockLines(toDocHandle(doc)).map(truncateSerializedBlock);
}

export function responseAwareBaselineSnapshot(
  baseline: Uint8Array,
  bufferedUpdates: readonly Uint8Array[],
): Uint8Array {
  if (bufferedUpdates.length === 0) return baseline;
  const doc = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(doc, baseline, { type: "system" });
    for (const update of bufferedUpdates) {
      Y.applyUpdate(doc, update, { type: "system" });
      if (hasPendingIntegration(doc)) {
        throw new Error("Buffered response update is not integrable into the interaction baseline");
      }
    }
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

export function baselineIntegratesBuffered(
  baseline: Uint8Array,
  bufferedUpdates: readonly Uint8Array[],
): boolean {
  try {
    responseAwareBaselineSnapshot(baseline, bufferedUpdates);
    return true;
  } catch {
    return false;
  }
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

export class BaselineIntegrationError extends Error {}

export function commandSelection(
  command: UndoCommand | RedoCommand,
): { ok: true; selection: ReversalSelection } | { ok: false; message: string } {
  const selectors = [
    command.to !== undefined || command.from !== undefined,
    command.last !== undefined,
    command.all === true,
  ].filter(Boolean).length;
  if (selectors > 1)
    return { ok: false, message: "Use only one undo/redo selector: to/from, last, or all." };
  if (command.all === true) return { ok: true, selection: { kind: "all" } };
  if (command.last !== undefined) {
    if (!Number.isInteger(command.last) || command.last < 1) {
      return { ok: false, message: "last must be a positive integer" };
    }
    return { ok: true, selection: { kind: "last", count: command.last } };
  }
  if (command.from !== undefined || command.to !== undefined) {
    if (command.to === undefined) return { ok: false, message: "from requires to" };
    if (!isWriteHandle(command.to))
      return { ok: false, message: "to must be a write handle like w3" };
    if (command.from === undefined)
      return { ok: true, selection: { kind: "single", to: command.to } };
    if (!isWriteHandle(command.from))
      return { ok: false, message: "from must be a write handle like w2" };
    if (Number(command.from.slice(1)) > Number(command.to.slice(1))) {
      return { ok: false, message: "from must be before or equal to to" };
    }
    return { ok: true, selection: { kind: "range", from: command.from, to: command.to } };
  }
  return { ok: true, selection: { kind: "latest" } };
}

export function agentMeta(turnId: string): UpdateMeta {
  return { origin: `agent:${turnId}`, actorTurnId: turnId, seq: 0 };
}

export function agentUpdateOrigin(turnId: string): ConcurrentUpdateOrigin & { type: "agent" } {
  return { type: "agent", actorTurnId: turnId };
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

function blockHashes(lines: readonly string[]): Set<string> {
  return new Set(
    lines.map((line) => {
      const separator = line.indexOf("|");
      return separator < 0 ? line : line.slice(0, separator);
    }),
  );
}

function isWriteHandle(value: string): boolean {
  return parseWriteHandle(value) !== undefined;
}

function hasPendingIntegration(doc: Y.Doc): boolean {
  const store = doc.store as {
    pendingStructs?: unknown | null;
    pendingDs?: unknown | null;
  };
  return store.pendingStructs !== null || store.pendingDs !== null;
}
