// Formats shared write and reversal responses for the tool surface.
import type { ConcurrentEditInfo } from "../apply/types.js";
import type { InternalWriteResult } from "./internal-result.js";
import type {
  WriteCommandName,
  WriteErrorDetail,
  WriteErrorStatus,
  WriteOutcome,
  WriteStatus,
  WriteSuccessPhase,
} from "./types.js";

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
  const lines = ["concurrent edits:"];
  appendConcurrentBucket(lines, "human", info.human, info.renderedBlocks?.human, options);
  appendConcurrentBucket(lines, "agent", info.agent, info.renderedBlocks?.agent, options);
  if (info.reviewCommand) lines.push(info.reviewCommand);
  return lines;
}

function appendConcurrentBucket(
  lines: string[],
  label: "human" | "agent",
  hashes: readonly string[],
  renderedBlocks: readonly string[] | undefined,
  options: { excludeHashes?: ReadonlySet<string> },
): void {
  if (hashes.length === 0) return;
  lines.push(`  ${label}: ${hashes.join(", ")}`);
  for (const block of renderedBlocks ?? []) {
    if (options.excludeHashes?.has(blockHash(block))) continue;
    lines.push(`    ${block}`);
  }
}

function blockHash(serialized: string): string {
  const separator = serialized.indexOf("|");
  return separator < 0 ? serialized : serialized.slice(0, separator);
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
