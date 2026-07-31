/**
 * What choosing a row does to the document.
 *
 * One shape, and the wire format is why: the codec spells a link as
 * `[[target]]` only when the link's text IS its target and it carries no
 * title. Anything else round-trips as `[text]([[target]])`, which is not a
 * wikilink at all. So the inserted text is the name, exactly, and the href is
 * the classifier's own spelling of it rather than brackets pasted together
 * here.
 *
 * A name the link system will not accept inserts nothing: the menu never
 * writes something into the manuscript that the resolver, the hint, and the
 * click would each read as a different thing.
 */

import type { Editor } from "@tiptap/core";

import { normalizeLinkHref } from "../../links";

export type WikilinkRange = { from: number; to: number };

export function insertWikilink(editor: Editor, range: WikilinkRange, name: string): boolean {
  const href = normalizeLinkHref(`[[${name}]]`);
  if (!href || !editor.isEditable) return false;
  const text = href.slice(2, -2);

  return (
    editor
      .chain()
      .focus()
      .insertContentAt(range, {
        type: "text",
        text,
        marks: [{ type: "link", attrs: { href, title: null } }],
      })
      // The link mark is non-inclusive, so the sentence continues unlinked; this
      // clears what the insertion left in the stored marks so the very next
      // keystroke agrees with that.
      .unsetMark("link")
      .run()
  );
}
