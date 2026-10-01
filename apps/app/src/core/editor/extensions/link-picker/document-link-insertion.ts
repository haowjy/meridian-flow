/**
 * What choosing a document writes: a standard link to its address, labeled
 * with its name. The href is `spellDocumentHref`'s, relative within the
 * holder's area and a full Context URI across areas, so the picker, `@`
 * references, and the link form spell one destination one way.
 */

import { spellDocumentHref } from "@meridian/contracts";
import type { Editor } from "@tiptap/core";

export type DocumentLinkRange = { from: number; to: number };

export function insertDocumentLink(
  editor: Editor,
  range: DocumentLinkRange,
  link: { label: string; uri: string; holderUri: string | null },
): boolean {
  if (!editor.isEditable || !link.label) return false;
  const href = spellDocumentHref(link.holderUri, link.uri);
  return (
    editor
      .chain()
      .focus()
      .insertContentAt(range, {
        type: "text",
        text: link.label,
        marks: [{ type: "link", attrs: { href, title: null } }],
      })
      // The link mark is non-inclusive, so the sentence continues unlinked; this
      // clears what the insertion left in the stored marks so the very next
      // keystroke agrees with that.
      .unsetMark("link")
      .run()
  );
}
