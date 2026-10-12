/**
 * What choosing a row in the Editor's `@` menu writes: a standard link labeled
 * with a name, naming its target by ref and spelled with the target's full
 * Context URI as it stands now. Every surface spells it for its reader from
 * there; the `href` is only where the link pointed when it was written.
 *
 * Both producers assign refs without parsing and without the network: a
 * document row knows its id, and the link-ahead row mints an ahead ref for
 * its address.
 */

import {
  aheadAddress,
  documentRef,
  type LinkRef,
  mintAheadRef,
  storedHref,
} from "@meridian/contracts";
import type { Editor } from "@tiptap/core";

export type DocumentLinkRange = { from: number; to: number };

/** A document row: `doc:<id>` at the document's current address. */
export function insertDocumentReference(
  editor: Editor,
  range: DocumentLinkRange,
  document: { label: string; documentId: string; uri: string },
): boolean {
  return insertDocumentLink(editor, range, {
    label: document.label,
    ref: documentRef(document.documentId),
    href: storedHref(document.uri, ""),
  });
}

/**
 * The link-ahead row: a link, never a document. Its ahead ref is minted here
 * for exactly this address; the chip is dashed until a document arrives there
 * (a follow's Create, an upload, a move), which settles the ref on it. The
 * link itself never changes.
 */
export function insertLinkAhead(
  editor: Editor,
  range: DocumentLinkRange,
  row: { label: string; uri: string },
): boolean {
  const address = aheadAddress(row.uri, "link");
  if (!address) return false;
  return insertDocumentLink(editor, range, {
    label: row.label,
    ref: mintAheadRef(),
    href: storedHref(address, ""),
  });
}

function insertDocumentLink(
  editor: Editor,
  range: DocumentLinkRange,
  link: { label: string; ref: LinkRef; href: string },
): boolean {
  if (!editor.isEditable || !link.label) return false;
  return (
    editor
      .chain()
      .focus()
      .insertContentAt(range, {
        type: "text",
        text: link.label,
        marks: [{ type: "link", attrs: { href: link.href, title: null, ref: link.ref } }],
      })
      // The link mark is non-inclusive, so the sentence continues unlinked; this
      // clears what the insertion left in the stored marks so the very next
      // keystroke agrees with that.
      .unsetMark("link")
      .run()
  );
}
