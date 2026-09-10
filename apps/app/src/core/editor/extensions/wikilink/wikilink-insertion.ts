/**
 * What choosing a row does to the document.
 *
 * Insert the destination name as the initial visible text. A writer can later
 * edit that text independently; the codec emits [[target|display text]].
 *
 * A name the link system will not accept inserts nothing: the menu never
 * writes something into the manuscript that the resolver, the hint, and the
 * click would each read as a different thing.
 */

import { formatWikilink, wikilinkTarget } from "@meridian/markup";
import type { Editor } from "@tiptap/core";

import { normalizeLinkHref } from "../../links";

export type WikilinkRange = { from: number; to: number };

export function insertWikilink(editor: Editor, range: WikilinkRange, name: string): boolean {
  const href = normalizeLinkHref(formatWikilink(name));
  if (!href || !editor.isEditable) return false;
  const text = wikilinkTarget(href);
  if (!text) return false;

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
