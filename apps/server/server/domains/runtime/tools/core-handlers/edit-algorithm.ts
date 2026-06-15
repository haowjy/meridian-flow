/**
 * Pure text-edit algorithms for the core `edit` tool. Keeps range resolution
 * and application independent from ContextPort wiring so the runtime behavior
 * can be tested without app-layer adapters.
 */
export interface TextRange {
  start: number;
  end: number;
  newText: string;
}

/**
 * Count non-overlapping occurrences of `needle` in `content`.
 *
 * Returns 0 (not found), 1 (unique), or >1 (ambiguous). The ambiguity
 * check in resolveEditRanges relies on this — exactly one match is
 * required for an edit to be unambiguous.
 */
export function countOccurrences(content: string, needle: string): number {
  if (needle.length === 0) return content.length + 1;
  let count = 0;
  let searchFrom = 0;
  while (true) {
    const idx = content.indexOf(needle, searchFrom);
    if (idx === -1) break;
    count += 1;
    searchFrom = idx + needle.length;
  }
  return count;
}

/**
 * Resolve text edit ranges from oldText→newText pairs.
 *
 * For each edit: count occurrences of oldText in the content. Zero →
 * not-found error. More than one → ambiguous error (model must be more
 * specific). Exactly one → record the range.
 *
 * After resolving all ranges, runs an O(n²) overlap check — acceptable
 * because edits are typically few (< 10). Overlapping ranges return an
 * error because applying them sequentially would produce incorrect results.
 */
export function resolveEditRanges(
  content: string,
  edits: Array<{ oldText: string; newText: string }>,
): TextRange[] | { message: string } {
  const ranges: TextRange[] = [];

  for (const { oldText, newText } of edits) {
    const matchCount = countOccurrences(content, oldText);
    if (matchCount === 0) {
      return { message: `oldText not found in file: ${JSON.stringify(oldText)}` };
    }
    if (matchCount > 1) {
      return {
        message: `oldText is ambiguous (${matchCount} matches): ${JSON.stringify(oldText)}`,
      };
    }
    const start = content.indexOf(oldText);
    ranges.push({ start, end: start + oldText.length, newText });
  }

  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const a = ranges[i];
      const b = ranges[j];
      if (a.start < b.end && b.start < a.end) {
        return { message: "edits target overlapping regions" };
      }
    }
  }

  return ranges;
}

/**
 * Apply ordered edit ranges to a string.
 *
 * Sorts ranges by start position so they can be applied in a single
 * left-to-right pass. This avoids index drift — if ranges were applied
 * out-of-order, earlier edits would shift the positions of later ones.
 */
export function applyEditRanges(content: string, ranges: TextRange[]): string {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let result = "";
  let pos = 0;
  for (const range of sorted) {
    result += content.slice(pos, range.start);
    result += range.newText;
    pos = range.end;
  }
  result += content.slice(pos);
  return result;
}
