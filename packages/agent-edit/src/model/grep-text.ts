import type { DocumentLinkScope, MarkupCodec, PMNode } from "@meridian/markup";
import { markdownPlainText } from "./markdown-text-view.js";

const DESTINATION_FREE_LINKS: DocumentLinkScope = {
  spellLink: () => ({ href: "", address: null }),
  spellSource: () => ({ href: "", address: null }),
};

export function destinationFreeBlocks(markup: MarkupCodec, blocks: readonly PMNode[]): string[] {
  return markup.serializeBlocks(blocks, DESTINATION_FREE_LINKS).map((entry) => entry.body);
}

export function grepBlockText(destinationFree: string, node: PMNode, verbatim: boolean): string {
  return verbatim ? node.textContent : markdownPlainText(destinationFree);
}

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
