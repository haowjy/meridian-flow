// Formats shared write and reversal responses for the tool surface.
import type * as Y from "yjs";
import { truncateSerializedBlock } from "../apply/echo.js";
import type { ApplyEchoHunk, ConcurrentEditInfo } from "../apply/types.js";
import type { DocHandle } from "../handles.js";
import type { InternalWriteResult, WriteResultBlock } from "./internal-result.js";
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
  echo: ApplyEchoHunk[];
  concurrentEdits?: ConcurrentEditInfo;
  deletedBlocks?: readonly string[];
  lateSweep?: DestructiveSweepReport;
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

export function status(
  code: Exclude<WriteStatus, "success">,
  message?: string,
  options: { error?: WriteErrorDetail } = {},
): InternalWriteResult {
  return result(code, message ? `status: ${code}\n\n${message}` : `status: ${code}`, options);
}

export function result(
  status: "success",
  text: string,
  options: { phase: WriteSuccessPhase; error?: WriteErrorDetail },
): InternalWriteResult;
export function result(
  status: Exclude<WriteStatus, "success">,
  text: string,
  options?: { error?: WriteErrorDetail },
): InternalWriteResult;
export function result(
  status: WriteStatus,
  text: string,
  options: { phase?: WriteSuccessPhase; error?: WriteErrorDetail } = {},
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
    };
  }
  return { status, text, ...(options.error ? { error: options.error } : {}) };
}

export function toOutcome(command: WriteCommandName, result: InternalWriteResult): WriteOutcome {
  const base = {
    command,
    isError: isWriteErrorStatus(result.status),
    ...(result.writeId ? { writeId: result.writeId } : {}),
    ...(result.error ? { error: result.error } : {}),
    text: result.text,
    ...(result.content ? { content: result.content } : {}),
  };
  if (result.status === "success") {
    return { ...base, status: "success", phase: result.phase };
  }
  return { ...base, status: result.status };
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
  const separator = serialized.indexOf("|");
  return separator < 0 ? serialized : serialized.slice(0, separator);
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
  return new Set(
    lines.map((line) => {
      const separator = line.indexOf("|");
      return separator < 0 ? line : line.slice(0, separator);
    }),
  );
}
