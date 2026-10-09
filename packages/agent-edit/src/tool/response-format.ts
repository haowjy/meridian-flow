// Formats shared write and reversal responses for the tool surface.
import type * as Y from "yjs";
import { truncateSerializedBlock } from "../apply/echo.js";
import type { ApplyEchoHunk, ConcurrentEditInfo } from "../apply/types.js";
import type { AgentEditCodec } from "../codec-adapter.js";
import type { DocHandle } from "../handles.js";
import type { AgentEditModel } from "../ports/model.js";
import type { CopySummary } from "./copy-receipt.js";
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
  /** The write left the document with no text, only the one blank block every document keeps. */
  documentEmpty?: boolean;
  /** A copy reports this instead of echoing what it wrote; its edges are `hash|prefix` lines. */
  copied?: { summary: CopySummary; edges: readonly string[] };
}

/** A write whose content the document already held: nothing is reserved, applied or journaled. */
export function formatUnchangedSuccess(): InternalWriteResult {
  return { status: "success", phase: "committed", revision: null, model: { unchanged: true } };
}

export interface ReversalSuccessResponseInput {
  direction: "undo" | "redo";
  status: UndoRedoOutcome;
  /** Write handles actually reversed, oldest first. */
  writeIds: readonly string[];
  sync: SyncedMutationSummary;
}

/** True when the document is down to one blank block, which removing every block leaves. */
export function isDocumentEmpty(
  model: AgentEditModel,
  codec: AgentEditCodec,
  doc: DocHandle,
): boolean {
  const blocks = model.getBlocks(doc);
  return (
    blocks.length <= 1 &&
    model.serializeBlockBodies(doc, codec, blocks).every((body) => body.trim() === "")
  );
}

export function formatApplySuccess(input: ApplySuccessResponseInput): InternalWriteResult {
  const blocks = input.copied ? copiedGroups(input.copied.edges) : echoGroups(input.echo);
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
      ...(input.copied
        ? { copied: { from: input.copied.summary.from, blocks: input.copied.summary.blocks } }
        : {}),
      ...(blocks.length > 0 || input.lateSweep ? { blocks } : {}),
      ...(input.concurrentEdits
        ? { concurrent: modelConcurrentResult(input.concurrentEdits) }
        : {}),
      ...(input.awarenessDegraded ? { awarenessDegraded: true } : {}),
      ...(input.documentEmpty ? { documentEmpty: true } : {}),
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
        writes: [...input.writeIds],
      },
      ...(blocks.length > 0 ? { blocks } : {}),
      ...(input.sync.concurrentEdits
        ? { concurrent: modelConcurrentResult(input.sync.concurrentEdits) }
        : {}),
    },
  };
}

export function truncateCreateEcho(
  renderer: { renderBlockLines: (doc: DocHandle, codec: AgentEditCodec) => string[] },
  codec: AgentEditCodec,
  doc: Y.Doc,
  toDocHandle: (doc: Y.Doc) => DocHandle,
): string[] {
  return renderer.renderBlockLines(toDocHandle(doc), codec).map(truncateSerializedBlock);
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
    ...(result.nodes ? { nodes: result.nodes } : {}),
    ...(result.shownLinks && result.shownLinks.length > 0
      ? { shownLinks: result.shownLinks, shownView: result.shownView }
      : {}),
    result: model,
  };
  if (result.status === "success") {
    return { ...base, status: "success", phase: result.phase };
  }
  return { ...base, status: result.status };
}

function copiedGroups(edges: readonly string[]): AgentEditBlockGroup[] {
  return edges.length > 0
    ? [{ extent: "prefix", relation: "copied", items: edges.map(modelBlockItem) }]
    : [];
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
    status === "read_required" ||
    status === "binary_file" ||
    status === "permission_denied" ||
    status === "internal_error"
  );
}
