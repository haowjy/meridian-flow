/**
 * Where a searched passage is in the document *now* — the honest half of a
 * search-match door.
 *
 * A search result names a block and the term that matched it. Between the
 * search and the click the writer may have edited, moved or deleted that
 * block, so arriving means re-deciding, against live text, whether the promise
 * can still be kept. Three outcomes, and no fourth: the passage is where it
 * said, the passage is somewhere unambiguous, or we say it changed. Landing on
 * a nearby-but-wrong paragraph is the failure this module exists to refuse.
 *
 * Pure over a ProseMirror document: no editor, no Yjs, no timing.
 *
 * The searchable projection is the delicate part. It must find exactly what the
 * server's search would find, and nothing the writer did not write: text either
 * side of a line break or an image is not one word, and case folding is neither
 * length-preserving nor context-free in every language.
 */
import type { Node as PMNode } from "@tiptap/pm/model";

export type TextRange = { from: number; to: number };

export type PassageResolution =
  /** The block still holds the term. Its occurrences there are the landing. */
  | { kind: "block"; ranges: TextRange[] }
  /** The block is gone or has changed, but the term occurs exactly once. */
  | { kind: "refound"; ranges: TextRange[] }
  /** Nowhere, or several equally plausible somewheres. Say so instead of guessing. */
  | { kind: "stale" };

/**
 * Resolve a searched passage against live text. `block` is the span the block
 * hash resolved to, or null when the hash no longer names a live block.
 */
export function resolvePassage(
  doc: PMNode,
  block: TextRange | null,
  term: string,
): PassageResolution {
  if (term.length === 0) return { kind: "stale" };
  if (block) {
    const inside = findTerm(doc, term, block);
    if (inside.length > 0) return { kind: "block", ranges: inside };
  }
  // Outline's resilience without its "first duplicate wins": one occurrence is
  // an answer, several are a coin flip about the writer's own prose.
  const everywhere = findTerm(doc, term, { from: 0, to: doc.content.size });
  return everywhere.length === 1 ? { kind: "refound", ranges: everywhere } : { kind: "stale" };
}

/**
 * Every occurrence of `term` inside `range`, case-insensitively — the casing
 * the search itself matched with.
 */
function findTerm(doc: PMNode, term: string, range: TextRange): TextRange[] {
  const needle = term.toLowerCase();
  if (needle.length === 0) return [];
  const found: TextRange[] = [];
  const from = Math.max(0, range.from);
  const to = Math.min(doc.content.size, range.to);
  if (from >= to) return found;

  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    for (const run of textRuns(node, pos + 1)) {
      let index = run.folded.indexOf(needle);
      while (index >= 0) {
        const start = run.source[index].from;
        const end = run.source[index + needle.length - 1].to;
        if (start >= from && end <= to) found.push({ from: start, to: end });
        index = run.folded.indexOf(needle, index + needle.length);
      }
    }
    // A textblock's inline content is already flattened above.
    return false;
  });
  return found;
}

/**
 * One stretch of uninterrupted text, folded for matching, with the document
 * range of the source character behind every folded character.
 */
type TextRun = { folded: string; source: TextRange[] };

/**
 * A textblock's inline content as searchable runs.
 *
 * **Runs break at every non-text inline leaf.** A hard break or an image
 * separates words the way a space does, so joining across one would let `gate`
 * and `keeper` read as `gatekeeper` — a term the writer never wrote, offered
 * as the unique occurrence step 3 is allowed to jump to. Splitting makes
 * contiguity structural rather than a separator character we hope nobody
 * searches for.
 *
 * **A whole run folds at once, because case is contextual.** `"ΟΣ"` lowercases
 * to `"ος"` with a final sigma, while folding its letters one at a time gives
 * `"οσ"` — which fails to match the server's needle and happily matches the
 * `"ος"` inside a later `"πύργος"`. The server folds whole strings, so a run
 * is the smallest unit that can agree with it.
 *
 * **Folded length is still not source length.** `"İ".toLowerCase()` is two
 * code units, so every folded unit carries the range of the source code point
 * behind it, walked by code point so a surrogate pair is never split. The
 * contextual substitutions are one-for-one, which is what lets that per-code-
 * point count describe the whole-run fold; when the two ever disagree in
 * length, the run is searched through the text its own map describes rather
 * than reporting a position we cannot justify. Marks also cut text into
 * several nodes, which is why this walks children instead of `textContent`.
 */
function textRuns(block: PMNode, start: number): TextRun[] {
  const runs: TextRun[] = [];
  let text = "";
  let perCodePoint = "";
  let source: TextRange[] = [];
  let offset = 0;

  const endRun = () => {
    if (text.length > 0) {
      const folded = text.toLowerCase();
      runs.push({ folded: folded.length === source.length ? folded : perCodePoint, source });
    }
    text = "";
    perCodePoint = "";
    source = [];
  };

  block.forEach((child) => {
    if (child.isText && child.text) {
      let index = 0;
      for (const character of child.text) {
        const range = {
          from: start + offset + index,
          to: start + offset + index + character.length,
        };
        const lowered = character.toLowerCase();
        for (let unit = 0; unit < lowered.length; unit += 1) source.push(range);
        perCodePoint += lowered;
        index += character.length;
      }
      text += child.text;
    } else {
      endRun();
    }
    offset += child.nodeSize;
  });
  endRun();
  return runs;
}
