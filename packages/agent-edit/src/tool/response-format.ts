// Formats shared write and reversal responses for the tool surface.
import type * as Y from "yjs";
import { truncateSerializedBlock } from "../apply/echo.js";
import type { ApplyEchoHunk, ConcurrentEditInfo } from "../apply/types.js";
import type { DocHandle } from "../handles.js";
import { splitHashline } from "../model/hashline.js";
import type { TurnDiffResult } from "../ports/turn-diff-query.js";
import type { InternalWriteResult, WriteResultBlock } from "./internal-result.js";
import {
  type AgentEditBlockRecord,
  type AgentEditBlockRelation,
  modelBlockRecord,
  modelConcurrentResult,
  modelResult,
} from "./model-result.js";
import type { DestructiveSweepReport } from "./mutation-commit.js";
import type {
  WriteCommandName,
  WriteErrorDetail,
  WriteErrorStatus,
  WriteOutcome,
  WriteStatus,
  WriteSuccessPhase,
} from "./types.js";

export interface ApplySuccessResponseInput {
  phase: WriteSuccessPhase;
  writeId?: string;
  settlementId?: string;
  echo: ApplyEchoHunk[];
  concurrentEdits?: ConcurrentEditInfo;
  deletedBlocks?: readonly string[];
  lateSweep?: DestructiveSweepReport;
  awarenessDegraded?: boolean;
}

export function formatTurnDiff(diff: TurnDiffResult | null): InternalWriteResult {
  if (diff?.changes.length === 0 && diff.sharedEffects) {
    const provisional =
      diff.trailState !== "settled"
        ? "\nResults are provisional until the thread-shared change trail settles."
        : "";
    return result(
      "success",
      `status: success\n\nNo turn-owned changes; thread-shared effects exist for this turn's documents.${provisional}`,
      { phase: "committed", model: { diff } },
    );
  }
  if (!diff || diff.changes.length === 0) {
    const provisional =
      diff?.trailState !== "settled"
        ? "\nResults are provisional until the turn's change trail settles."
        : "";
    return result(
      "success",
      `status: success\n\nNo settled changes for this turn yet.${provisional}`,
      { phase: "committed", model: { diff } },
    );
  }

  const lines = ["status: success", `trail state: ${diff.trailState}`];
  if (diff.trailState !== "settled") {
    lines.push("Results are provisional until the turn's change trail settles.");
  }
  lines.push(
    diff.sharedEffects
      ? "Thread-shared effects also exist for these documents; they are not attributed to this turn."
      : "Thread-shared effects: none for these documents.",
  );

  for (const [index, change] of diff.changes.entries()) {
    lines.push("", `Change ${index + 1}: ${change.kind} in document ${change.documentId}`);
    lines.push("Before:", change.before ?? "[no content]");
    lines.push("After:", change.after ?? "[no content]");
    for (const merged of change.mergedOver) {
      lines.push(
        merged.writerAuthored
          ? "Merged over writer-authored content:"
          : "Merged over agent content:",
        merged.body,
      );
    }
  }

  return result("success", lines.join("\n"), { phase: "committed", model: { diff } });
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
  if (input.lateSweep) {
    metaLines.push("concurrent writer content swept during commit; re-read required");
    for (const { hash, body } of input.lateSweep.capturedDeletedBodies ?? []) {
      metaLines.push(`swept: ${hash}|${body}`);
    }
  }
  if (input.awarenessDegraded) {
    metaLines.push("destructive awareness degraded after durable recovery; re-read required");
  }

  const content: WriteResultBlock[] = [{ type: "text", text: metaLines.join("\n") }];
  if (echoLines.length > 0) content.push({ type: "text", text: echoLines.join("\n") });

  return {
    status: "success",
    phase: input.phase,
    text: content.map((block) => block.text).join("\n\n"),
    content,
    model: {
      ...(input.writeId || (input.deletedBlocks && input.deletedBlocks.length > 0)
        ? {
            write: {
              ...(input.writeId ? { id: input.writeId } : {}),
              ...(input.deletedBlocks && input.deletedBlocks.length > 0
                ? { deletedHashes: [...input.deletedBlocks] }
                : {}),
            },
          }
        : {}),
      ...(echoLines.length > 0 ? { blocks: echoRecords(input.echo) } : {}),
      ...(input.concurrentEdits
        ? { concurrent: modelConcurrentResult(input.concurrentEdits) }
        : {}),
      ...(input.lateSweep
        ? {
            blocks: [
              ...echoRecords(input.echo),
              ...(input.lateSweep.capturedDeletedBodies ?? []).map(
                ({ hash, body }): AgentEditBlockRecord => ({
                  hash,
                  body,
                  extent: "full",
                  relation: "swept",
                }),
              ),
            ],
          }
        : {}),
      ...(input.awarenessDegraded ? { awarenessDegraded: true } : {}),
    },
    ...(input.writeId ? { writeId: input.writeId } : {}),
    ...(input.settlementId ? { settlementId: input.settlementId } : {}),
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
  return result(code, message ? `status: ${code}\n\n${message}` : `status: ${code}`, {
    ...options,
    ...(message ? { model: { message } } : {}),
  });
}

export function result(
  status: "success",
  text: string,
  options: {
    phase: WriteSuccessPhase;
    error?: WriteErrorDetail;
    model?: InternalWriteResult["model"];
  },
): InternalWriteResult;
export function result(
  status: Exclude<WriteStatus, "success">,
  text: string,
  options?: { error?: WriteErrorDetail; model?: InternalWriteResult["model"] },
): InternalWriteResult;
export function result(
  status: WriteStatus,
  text: string,
  options: {
    phase?: WriteSuccessPhase;
    error?: WriteErrorDetail;
    model?: InternalWriteResult["model"];
  } = {},
): InternalWriteResult {
  if (status === "success") {
    if (!options.phase) {
      throw new Error("success results require phase");
    }
    return {
      status,
      phase: options.phase,
      text,
      ...(options.error ? { error: options.error } : {}),
      ...(options.model ? { model: options.model } : {}),
    };
  }
  return {
    status,
    text,
    ...(options.error ? { error: options.error } : {}),
    ...(options.model ? { model: options.model } : {}),
  };
}

export function toOutcome(command: WriteCommandName, result: InternalWriteResult): WriteOutcome {
  const base = {
    command,
    isError: isWriteErrorStatus(result.status),
    ...(result.writeId ? { writeId: result.writeId } : {}),
    ...(result.settlementId ? { settlementId: result.settlementId } : {}),
    ...(result.error ? { error: result.error } : {}),
    result: modelResult({
      command,
      status: result.status,
      ...(result.status === "success" ? { phase: result.phase } : {}),
      ...(result.model ? { payload: result.model } : {}),
    }),
    text: result.text,
  };
  if (result.status === "success") {
    return { ...base, status: "success", phase: result.phase };
  }
  return { ...base, status: result.status };
}

export function blockRecord(
  serialized: string,
  extent: "full" | "prefix",
  relation: AgentEditBlockRelation,
): AgentEditBlockRecord {
  return modelBlockRecord(serialized, extent, relation);
}

function echoRecords(echo: readonly ApplyEchoHunk[]): AgentEditBlockRecord[] {
  return echo.flatMap((hunk) =>
    hunk.blocks
      .filter((serialized) => serialized.length > 0)
      .map((serialized) =>
        blockRecord(
          serialized,
          hunk.mode === "full" ? "full" : "prefix",
          hunk.mode === "full" ? "changed" : "context",
        ),
      ),
  );
}

export function formatConcurrent(
  info: ConcurrentEditInfo,
  options: { excludeHashes?: ReadonlySet<string> } = {},
): string[] {
  const runs: string[] = [];
  for (const run of info.runs) {
    const entries: string[] = [];
    for (const block of run.blocks) {
      if (!options.excludeHashes?.has(blockHash(block))) entries.push(`    ${block}`);
    }
    for (const tombstone of run.tombstones) {
      entries.push(`    ${tombstone.hash}| [explicit deletion]\n${tombstone.capturedBody}`);
    }
    if (entries.length > 0) runs.push(`  ${run.origin}:`, ...entries);
  }
  const lines = runs.length > 0 ? ["concurrent edits:", ...runs] : [];
  if (info.syncOverflow) lines.push("sync_overflow: fresh bounded read required");
  return lines;
}

function blockHash(serialized: string): string {
  return splitHashline(serialized)?.hash ?? serialized;
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

function blockHashes(lines: readonly string[]): Set<string> {
  return new Set(lines.map(blockHash));
}
