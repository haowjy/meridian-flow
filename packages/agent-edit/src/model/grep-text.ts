// The text `grep` matches, produced by one function on both of grep's paths:
// the derivation stores it beside the projection, and a live hashline read
// computes it per block. Same blocks, same codec call, same function: the two
// agree by construction.
//
// A block is serialized the way a hashline body is (`serializeBlocks`, never
// the whole-document `serialize`, which joins blocks with blank lines and
// writes an empty paragraph as U+00A0) with every link and image destination
// spelled empty, so a match never depends on which reader's address spelling
// a destination took. The grep text is that markdown decoded to the writer's
// text view, blocks joined with `\n`.
import type { DocumentLinkScope, MarkupCodec, PMNode } from "@meridian/markup";
import { markdownPlainText } from "./markdown-text-view.js";

const DESTINATION_FREE_LINKS: DocumentLinkScope = {
  spellLink: () => ({ href: "", address: null }),
  spellSource: () => ({ href: "", address: null }),
};

/** Each block's markdown with link and image destinations spelled empty. */
export function destinationFreeBlocks(markup: MarkupCodec, blocks: readonly PMNode[]): string[] {
  return markup.serializeBlocks(blocks, DESTINATION_FREE_LINKS);
}

/** The grep text of blocks already serialized by {@link destinationFreeBlocks}. */
export function grepText(destinationFree: readonly string[]): string {
  return destinationFree.map((markdown) => markdownPlainText(markdown)).join("\n");
}

/**
 * Where a range of a block's destination-free markdown sits in the block's real body.
 *
 * The two differ only inside link and image occurrences, so each occurrence's two spans
 * (the markup package's own source spans, never a re-read of the link grammar) are
 * compared: what both share at the front and at the back lines up, and what sits between
 * (the destination, which the destination-free form spells empty) maps to the body's
 * whole destination. A range that starts or ends inside it widens to cover it. Null when
 * the two parses disagree on how many occurrences there are.
 */
export function bodyRange(
  markup: MarkupCodec,
  destinationFree: string,
  body: string,
  range: { start: number; end: number },
): { start: number; end: number } | null {
  if (destinationFree === body) return range;
  const free = markup.parseWithSpans(destinationFree).spans;
  const real = markup.parseWithSpans(body).spans;
  if (free.length !== real.length) return null;
  const place = (at: number, side: "start" | "end"): number => {
    let shift = 0;
    for (const [index, span] of free.entries()) {
      if (at < span.start) break;
      const full = real[index] as (typeof real)[number];
      const limit = Math.min(span.end - span.start, full.end - full.start);
      let front = 0;
      while (front < limit && destinationFree[span.start + front] === body[full.start + front])
        front += 1;
      let back = 0;
      while (
        back < limit - front &&
        destinationFree[span.end - 1 - back] === body[full.end - 1 - back]
      )
        back += 1;
      const frontEnd = span.start + front;
      const backStart = span.end - back;
      if (side === "start" ? at < frontEnd : at <= frontEnd) return full.start + (at - span.start);
      if (side === "start" ? at < backStart : at <= backStart)
        return side === "start" ? frontEnd - span.start + full.start : full.end - back;
      if (at <= span.end) return full.end - (span.end - at);
      shift = full.end - span.end;
    }
    return at + shift;
  };
  return { start: place(range.start, "start"), end: place(range.end, "end") };
}
