// Formats shared write and reversal responses for the tool surface.
import type { ApplyEchoHunk, ConcurrentEditInfo } from "../apply/types.js";
import type { InternalWriteResult } from "./internal-result.js";
import type { WriteCommandName, WriteErrorStatus, WriteOutcome, WriteStatus } from "./types.js";

export function status(code: WriteStatus, message?: string): InternalWriteResult {
  return result(code, message ? `status: ${code}\n\n${message}` : `status: ${code}`);
}

export function result(status: WriteStatus, text: string): InternalWriteResult {
  return { status, text };
}

export function toOutcome(command: WriteCommandName, result: InternalWriteResult): WriteOutcome {
  return {
    command,
    status: result.status,
    isError: isWriteErrorStatus(result.status),
    ...(result.writeId ? { writeId: result.writeId } : {}),
    text: result.text,
  };
}

export function formatConcurrentCommitEcho(input: {
  echoes: readonly (readonly ApplyEchoHunk[] & { writeId?: string })[];
  concurrentEdits?: ConcurrentEditInfo;
}): string {
  const lines = ["status: success"];
  const echoLines = input.echoes
    .flatMap((entry) =>
      entry.flatMap((hunk) =>
        hunk.blocks.map((block) => (entry.writeId ? `${entry.writeId}: ${block}` : block)),
      ),
    )
    .filter((line) => line.length > 0);
  if (echoLines.length > 0) lines.push("", ...echoLines);
  if (input.concurrentEdits) lines.push("", ...formatConcurrent(input.concurrentEdits));
  return lines.join("\n");
}

export function formatConcurrent(info: ConcurrentEditInfo): string[] {
  const lines = ["concurrent edits:"];
  if (info.human.length > 0) lines.push(`  human: ${info.human.join(", ")}`);
  if (info.agent.length > 0) lines.push(`  agent: ${info.agent.join(", ")}`);
  if (info.reviewCommand) lines.push(info.reviewCommand);
  return lines;
}

function isWriteErrorStatus(status: WriteStatus): status is WriteErrorStatus {
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
