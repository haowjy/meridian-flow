/**
 * The slot a picture takes in the prose, wherever the picture came from.
 *
 * Two doors reach it. An upload opens a slot whose bytes are still travelling
 * (`image-uploads.ts`), and `@` names an asset the project already has
 * (`extensions/at-reference/`). What lands is the same object either way — the
 * inline `image` node §5.6 settled, in the same place, with the caret left in
 * the same spot — because a picture a writer referenced and a picture a writer
 * uploaded are the same picture, and two insertion paths are two answers to
 * "where may a picture stand" that drift the first time the schema changes.
 *
 * `image` is an inline atom, so where it can sit is a schema question and not a
 * preference: inside a paragraph it goes between the words, and anywhere that
 * cannot hold an inline picture (the seam between blocks, a code fence) it
 * arrives in a paragraph of its own after that block. Null is the refusal, for
 * a position that can take neither — and the caller says what that means to the
 * writer, because "a picture cannot go there" and "that place is gone" are
 * different sentences.
 */

import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";

import { UPLOAD_TOKEN_ATTR } from "./pending-images";

/** What the writer is putting in the slot. */
export type InlineImage = {
  /** `asset:<documentId>` for a picture the project has; `""` while bytes travel. */
  src: string;
  alt: string;
  /** Set only by the upload lane: the slot some browser is filling right now. */
  uploadToken?: string;
};

/**
 * Put a picture at `at`, replacing whatever that range holds.
 *
 * The range is how a trigger hands over its own text: `@map.png` is consumed
 * and the picture stands where it stood, in one transaction, so one undo takes
 * the writer back to the sentence they were typing. An empty range (the upload
 * lane's) inserts without consuming anything.
 *
 * Returns the position the picture landed at, which is what a caller that has
 * to write to that node again needs.
 */
export function insertInlineImage(
  editor: Editor,
  image: InlineImage,
  at?: { from: number; to: number },
): number | null {
  const { state } = editor;
  const imageType = state.schema.nodes.image;
  const paragraphType = state.schema.nodes.paragraph;
  if (!imageType || !paragraphType) return null;

  const clamp = (pos: number) => Math.max(0, Math.min(pos, state.doc.content.size));
  const from = clamp(at?.from ?? state.selection.from);
  const to = Math.max(from, clamp(at?.to ?? from));

  const node = imageType.create({
    src: image.src,
    alt: image.alt,
    title: null,
    [UPLOAD_TOKEN_ATTR]: image.uploadToken ?? null,
  });

  const transaction = state.tr;
  // The trigger's own text goes first, so what follows resolves against the
  // document the picture will actually stand in rather than against one with a
  // dead query still in it.
  if (to > from) transaction.delete(from, to);

  const $target = transaction.doc.resolve(from);
  let imagePos: number;

  if ($target.parent.canReplaceWith($target.index(), $target.index(), imageType)) {
    transaction.insert(from, node);
    imagePos = from;
  } else {
    const seam = $target.depth === 0 ? from : $target.after($target.depth);
    const $seam = transaction.doc.resolve(seam);
    if (!$seam.parent.canReplaceWith($seam.index(), $seam.index(), paragraphType)) return null;
    transaction.insert(seam, paragraphType.create(null, node));
    imagePos = seam + 1;
  }

  // The caret lands after the picture: the writer asked for an image mid
  // sentence and the sentence continues.
  transaction.setSelection(TextSelection.near(transaction.doc.resolve(imagePos + 1)));
  transaction.scrollIntoView();
  editor.view.dispatch(transaction);
  return imagePos;
}
