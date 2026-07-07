// Formats shared write and reversal responses for the tool surface.
import type { ConcurrentEditInfo } from "../apply/types.js";
import type { InternalWriteResult } from "./internal-result.js";
import type {
  WriteCommandName,
  WriteErrorDetail,
  WriteErrorStatus,
  WriteOutcome,
  WriteStatus,
} from "./types.js";

export function status(
  code: WriteStatus,
  message?: string,
  options: { error?: WriteErrorDetail } = {},
): InternalWriteResult {
  return result(code, message ? `status: ${code}\n\n${message}` : `status: ${code}`, options);
}

export function result(
  status: WriteStatus,
  text: string,
  options: { error?: WriteErrorDetail } = {},
): InternalWriteResult {
  return { status, text, ...(options.error ? { error: options.error } : {}) };
}

export function toOutcome(command: WriteCommandName, result: InternalWriteResult): WriteOutcome {
  return {
    command,
    status: result.status,
    isError: isWriteErrorStatus(result.status),
    ...(result.writeId ? { writeId: result.writeId } : {}),
    ...(result.error ? { error: result.error } : {}),
    text: result.text,
    ...(result.content ? { content: result.content } : {}),
  };
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
