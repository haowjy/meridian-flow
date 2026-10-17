/**
 * Edit receipts for rows appended to a branch, computed on the candidate before the append
 * commits: the store writes them under the row lock, it never computes them there.
 */
import { captureEditFrontier, captureEditParts } from "@meridian/agent-edit/integration";
import * as Y from "yjs";
import type { AppendBranchJournalInput, AppendReceiptGroup } from "./branch-store.js";

/**
 * Applies `rows` to `candidate` in order, each with the frontier of the document just
 * before it, then captures every logical write (`documentEditKey`, else one write per row)
 * against the final document. `candidate` ends holding every row.
 */
export function captureAppendReceipts(
  candidate: Y.Doc,
  rows: readonly AppendBranchJournalInput[],
): AppendReceiptGroup[] {
  const stepped = rows.map((row) => {
    const frontier = captureEditFrontier(candidate);
    Y.applyUpdate(candidate, row.updateData);
    return { update: row.updateData, frontier };
  });
  const groups = new Map<string, number[]>();
  for (const [index, row] of rows.entries()) {
    const key = row.documentEditKey ?? `${row.threadId}:${row.wId ?? `#${index}`}`;
    groups.set(key, [...(groups.get(key) ?? []), index]);
  }
  return [...groups.values()].map((rowIndexes) => ({
    rowIndexes,
    parts: captureEditParts(
      candidate,
      rowIndexes.map((index) => stepped[index]),
    ),
  }));
}
