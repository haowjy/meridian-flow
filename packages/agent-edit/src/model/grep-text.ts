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
