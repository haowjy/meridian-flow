// Formats shared write and reversal responses for the tool surface.
import type * as Y from "yjs";
import { truncateSerializedBlock } from "../apply/echo.js";
import type { ApplyEchoHunk, ConcurrentEditInfo } from "../apply/types.js";
import type { DocHandle } from "../handles.js";
import { splitHashline } from "../model/hashline.js";
import type { InternalWriteResult } from "./internal-result.js";
import {
  type AgentEditBlockGroup,
  type AgentEditResultCommand,
  modelBlockItem,
  modelConcurrentResult,
  modelResult,
} from "./model-result.js";
import type { DestructiveSweepReport, SyncedMutationSummary } from "./mutation-commit.js";
import type {
  UndoRedoOutcome,
  WriteErrorDetail,
  WriteErrorStatus,
  WriteOutcome,
  WriteStatus,
  WriteSuccessPhase,
} from "./types.js";

export interface ApplySuccessResponseInput {
  revision?: string | null;
  phase: WriteSuccessPhase;
  writeId?: string;
  settlementId?: string;
  echo: ApplyEchoHunk[];
  concurrentEdits?: ConcurrentEditInfo;
  deletedBlocks?: readonly string[];
  lateSweep?: DestructiveSweepReport;
  awarenessDegraded?: boolean;
}

export interface ReversalSuccessResponseInput {
  direction: "undo" | "redo";
  status: UndoRedoOutcome;
  targetCount?: number;
  sync: SyncedMutationSummary;
}

export function formatApplySuccess(input: ApplySuccessResponseInput): InternalWriteResult {
  const blocks = echoGroups(input.echo);
  const swept = input.lateSweep?.capturedDeletedBodies ?? [];
  if (swept.length > 0) {
    blocks.push({
      extent: "full",
      relation: "swept",
      items: swept.map(({ hash, body }) => ({ hash, body })),
    });
  }
  const deletedHashes = input.deletedBlocks ?? [];

  return {
    status: "success",
    phase: input.phase,
    revision: input.revision ?? null,
    model: {
      ...(input.writeId || deletedHashes.length > 0
        ? {
            write: {
              ...(input.writeId ? { id: input.writeId } : {}),
              ...(deletedHashes.length > 0 ? { deletedHashes: [...deletedHashes] } : {}),
            },
          }
        : {}),
      ...(blocks.length > 0 || input.lateSweep ? { blocks } : {}),
      ...(input.concurrentEdits
        ? { concurrent: modelConcurrentResult(input.concurrentEdits) }
        : {}),
      ...(input.awarenessDegraded ? { awarenessDegraded: true } : {}),
    },
    ...(input.writeId ? { writeId: input.writeId } : {}),
    ...(input.settlementId ? { settlementId: input.settlementId } : {}),
  };
}

export function formatReversalSuccess(input: ReversalSuccessResponseInput): InternalWriteResult {
  const blocks = echoGroups(input.sync.echo);
  return {
    status: input.status,
    revision: input.sync.revision ?? null,
    model: {
      reversal: {
        direction: input.direction,
        count: input.targetCount ?? 0,
      },
      ...(blocks.length > 0 ? { blocks } : {}),
      ...(input.sync.concurrentEdits
        ? { concurrent: modelConcurrentResult(input.sync.concurrentEdits) }
        : {}),
    },
  };
}

export function truncateCreateEcho(
  renderer: { renderBlockLines: (doc: DocHandle) => string[] },
  doc: Y.Doc,
  toDocHandle: (doc: Y.Doc) => DocHandle,
): string[] {
  return renderer.renderBlockLines(toDocHandle(doc)).map(truncateSerializedBlock);
}

export function status(
  code: Exclude<WriteStatus, "success">,
  message?: string,
  options: { error?: WriteErrorDetail } = {},
): InternalWriteResult {
  return {
    status: code,
    ...(options.error ? { error: options.error } : {}),
    ...(message ? { model: { message } } : {}),
  };
}

/** The typed outcome; `path` is the document the command read or changed. */
export function toOutcome(
  command: AgentEditResultCommand,
  result: InternalWriteResult,
  path?: string,
): WriteOutcome {
  const payload = { ...(path ? { path } : {}), ...result.model };
  const model =
    result.status === "success"
      ? modelResult({ command, status: "success", phase: result.phase, payload })
      : modelResult({ command, status: result.status, payload });
  const base = {
    command,
    revision: result.revision ?? null,
    isError: isWriteErrorStatus(result.status),
    ...(result.writeId ? { writeId: result.writeId } : {}),
    ...(result.settlementId ? { settlementId: result.settlementId } : {}),
    ...(result.error ? { error: result.error } : {}),
    result: model,
  };
  if (result.status === "success") {
    return { ...base, status: "success", phase: result.phase };
  }
  return { ...base, status: result.status };
}

function echoGroups(echo: readonly ApplyEchoHunk[]): AgentEditBlockGroup[] {
  const groups: AgentEditBlockGroup[] = [];
  for (const hunk of echo) {
    const serialized = hunk.blocks.filter((block) => block.length > 0);
    if (serialized.length === 0) continue;
    const items = serialized.map(modelBlockItem);
    groups.push(
      hunk.mode === "full"
        ? { extent: "full", relation: "changed", items }
        : { extent: "prefix", relation: "context", items },
    );
  }
  return groups;
}

export function isWriteErrorStatus(status: WriteStatus): status is WriteErrorStatus {
  return (
    status === "not_found" ||
    status === "ambiguous_match" ||
    status === "invalid_write" ||
    status === "document_not_found" ||
    status === "partial_failure" ||
    status === "cant_undo_dependent" ||
    status === "internal_error"
  );
}
