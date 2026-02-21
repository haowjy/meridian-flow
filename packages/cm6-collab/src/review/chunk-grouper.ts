import type { EditOp, ReviewChunk } from "./types";

/**
 * Group EditOps into prose-oriented ReviewChunks.
 *
 * Grouping rules (applied in order):
 *   1. Adjacent insert/delete at the same location become a single replace chunk
 *      (if not already merged by the extractor).
 *   2. Ops in the same paragraph (no blank line between them) are merged.
 *   3. Ops separated by <=2 unchanged lines are merged.
 *   4. Ops separated by >2 unchanged lines remain separate chunks.
 *
 * Chunk ids are deterministic: `${proposalId}-chunk-${index}`.
 */
export function groupIntoChunks(
  ops: EditOp[],
  proposalId: string,
  baseText: string,
): ReviewChunk[] {
  if (ops.length === 0) {
    return [];
  }

  // Convert each op into a preliminary chunk (1:1 mapping)
  const preliminary: ReviewChunk[] = ops.map((op, i) =>
    opToChunk(op, proposalId, i),
  );

  // Sort by baseStart so adjacent-proximity merging works left-to-right
  preliminary.sort((a, b) => a.baseStart - b.baseStart);

  // Merge nearby chunks using prose-oriented proximity rules
  const merged = mergeNearby(preliminary, baseText);

  // Re-assign stable ids after merging (index reflects final chunk position)
  return merged.map((chunk, i) => ({ ...chunk, id: `${proposalId}-chunk-${i}` }));
}

function opToChunk(op: EditOp, proposalId: string, index: number): ReviewChunk {
  if (op.kind === "insert") {
    return {
      id: `${proposalId}-chunk-${index}`,
      proposalId,
      baseStart: op.basePos,
      baseEnd: op.basePos, // insert covers zero base chars
      deletedText: "",
      insertedText: op.insertedText,
      status: "pending",
    };
  }

  if (op.kind === "delete") {
    return {
      id: `${proposalId}-chunk-${index}`,
      proposalId,
      baseStart: op.baseStart,
      baseEnd: op.baseEnd,
      deletedText: op.deletedText,
      insertedText: "",
      status: "pending",
    };
  }

  // replace
  return {
    id: `${proposalId}-chunk-${index}`,
    proposalId,
    baseStart: op.baseStart,
    baseEnd: op.baseEnd,
    deletedText: op.deletedText,
    insertedText: op.insertedText,
    status: "pending",
  };
}

/**
 * Merge consecutive chunks that are "close enough" in the base text.
 *
 * Two chunks A and B (A before B) are merged when the gap between them
 * (baseText[A.baseEnd..B.baseStart]) has <=2 lines.
 *
 * Line count: `gap.split("\n").length` — empty string gives 0, "foo" gives 1,
 * "foo\nbar" gives 2, "\n\n" (paragraph separator) gives 3 → does NOT merge.
 *
 * When merging:
 *   - deletedText = full base text from merged.baseStart to curr.baseEnd
 *     (captures the unchanged gap as context in the base)
 *   - insertedText = prev.insertedText + gapText + curr.insertedText
 *     (the gap text is unchanged in the proposed doc, so it appears in both)
 */
function mergeNearby(chunks: ReviewChunk[], baseText: string): ReviewChunk[] {
  if (chunks.length <= 1) {
    return chunks.slice();
  }

  // chunks[0] is guaranteed by the length guard above; prev/curr are guaranteed by loop bounds.
  const result: ReviewChunk[] = [{ ...chunks[0]! }];

  for (let i = 1; i < chunks.length; i++) {
    const prev = result[result.length - 1]!;
    const curr = chunks[i]!;

    // Gap in base text between prev's end and curr's start
    const gapStart = prev.baseEnd;
    const gapEnd = curr.baseStart;
    // Guard: if ops overlap or are adjacent, gapText is empty
    const gapText = gapStart <= gapEnd ? baseText.substring(gapStart, gapEnd) : "";

    if (shouldMerge(gapText)) {
      // Extend the previous chunk to cover curr
      result[result.length - 1] = {
        ...prev,
        baseEnd: curr.baseEnd,
        // Deleted text = full base text span (includes the unchanged gap as context)
        deletedText: baseText.substring(prev.baseStart, curr.baseEnd),
        // Inserted text = prev's insert + unchanged gap + curr's insert
        insertedText: prev.insertedText + gapText + curr.insertedText,
      };
    } else {
      result.push({ ...curr });
    }
  }

  return result;
}

/**
 * Decide whether to merge two chunks based on their gap text.
 *
 * Threshold: <=2 unchanged lines (split("\n").length <= 2).
 *
 * Examples:
 *   ""         → 0 → merge (same position)
 *   "foo"      → 1 → merge (same line or single line gap)
 *   "foo\nbar" → 2 → merge (one newline, same paragraph context)
 *   "\n"       → 2 → merge (blank-line transition, still close)
 *   "\n\n"     → 3 → DON'T merge (paragraph boundary)
 *   "a\nb\nc"  → 3 → DON'T merge (too far apart)
 */
function shouldMerge(gapText: string): boolean {
  if (gapText === "") {
    return true;
  }
  return gapText.split("\n").length <= 2;
}
