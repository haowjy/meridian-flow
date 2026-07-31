/**
 * What choosing an `@` row does to the document.
 *
 * Two kinds of thing, two objects that already exist, and nothing new on the
 * wire. A document becomes the same link mark `[[` writes — same text, same
 * href, byte for byte, because one primitive reached from two doors is the
 * whole point of this trigger and a second spelling would make every consumer
 * treat two things as one meaning forever. An asset becomes the same inline
 * `image` node the upload path lands, minus the upload: the asset exists and
 * the row carries its id.
 *
 * The `@query` the writer typed is what each replaces. Unlike `[[`, this lane
 * consumes no auto-paired closers past the caret: `@` opens no pair of its own,
 * so a `)` or a `"` sitting after the caret was written for an opener the
 * writer typed themselves — `( @map.png)` has to keep its parenthesis.
 */

import type { Editor, Range } from "@tiptap/core";

import { imageAltFromFilename, insertInlineImage } from "../../images";
import { insertWikilink } from "../wikilink";
import type { AtReferenceItem } from "./at-reference-catalog";

export function insertAtReference(editor: Editor, range: Range, item: AtReferenceItem): boolean {
  if (!editor.isEditable) return false;

  if (item.kind === "asset") {
    return (
      insertInlineImage(
        editor,
        // The stable ref, never a URL: a signed address in the shared document
        // expires while the chapter outlives it (`images/AGENTS.md`).
        { src: `asset:${item.assetDocumentId}`, alt: imageAltFromFilename(item.name) },
        range,
      ) !== null
    );
  }

  // Both the document row and the create row write a link and nothing else:
  // "links now, page later" is what a serial writer needs from a name they have
  // not written a page for yet.
  return insertWikilink(editor, range, item.name);
}
