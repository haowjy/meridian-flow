/**
 * Cut, Copy, and Paste for a menu item, which is a different problem from the
 * same three keys.
 *
 * A keystroke arrives as a clipboard event and ProseMirror handles it. A menu
 * item arrives with focus inside a portalled menu and no event to read, so the
 * clipboard has to be reached through the feature's clipboard adapter
 * ([`../../clipboard.ts`](../../clipboard.ts)) and the document through the
 * view's own serializer. Using that serializer is what makes a copy paste back
 * as structure rather than as flattened text: it writes both `text/html`
 * (carrying ProseMirror's slice depths) and `text/plain`.
 *
 * This file is the document half only. Whether a browser will hand the page a
 * clipboard, and what it did when asked, belong to the adapter — four surfaces
 * ask those questions and there is one answer. What is left here is what a
 * selection means: what to serialize, when a cut may delete, and where a paste
 * lands.
 *
 * Every one of these can be refused by the browser rather than by the document,
 * and a refusal has to reach the writer (law 5). So each returns what happened,
 * and the surface greys the control with its shortcut once a browser has said
 * no. Reading is refused far more often than writing — whole browsers withhold
 * it — but a permissions policy can withhold either.
 */

import type { Editor } from "@tiptap/core";

import { readClipboardText, writeClipboardRichText } from "../../clipboard";

export type ClipboardResult =
  /** The clipboard and the document both did their part. */
  | "done"
  /** The clipboard held nothing this editor can take. */
  | "empty"
  /** This browser does not expose the direction to the page at all. */
  | "unavailable"
  /** It exposes it and refused this one (permission, or a hostile context). */
  | "denied"
  /** The document would not take the content (read-only, schema). */
  | "refused";

export async function copySelection(editor: Editor): Promise<ClipboardResult> {
  if (editor.isDestroyed || editor.state.selection.empty) return "refused";
  const { view } = editor;
  const { dom, text } = view.serializeForClipboard(view.state.selection.content());
  // The adapter's statuses ARE the browser half of this vocabulary: a surface
  // that greys a row on "denied" reads the same word wherever it came from.
  return (await writeClipboardRichText(dom.innerHTML, text)).status;
}

/**
 * Copy, then delete — in that order, and only in that order. A cut whose copy
 * was refused would take the writer's words with nothing to paste back.
 */
export async function cutSelection(editor: Editor): Promise<ClipboardResult> {
  if (editor.isDestroyed || !editor.isEditable) return "refused";
  const copied = await copySelection(editor);
  if (copied !== "done") return copied;
  if (editor.isDestroyed) return "refused";
  return editor.chain().focus().deleteSelection().run() ? "done" : "refused";
}

export async function pasteIntoSelection(editor: Editor): Promise<ClipboardResult> {
  if (editor.isDestroyed || !editor.isEditable) return "refused";

  const held = await readClipboardText();
  if (held.status !== "done") return held.status;
  if (editor.isDestroyed) return "refused";

  // The caret never left the prose; the paste lands where the writer is
  // looking, so focus goes back before the transaction rather than after it.
  editor.commands.focus();
  const pasted = held.html
    ? editor.view.pasteHTML(held.html)
    : editor.view.pasteText(held.text ?? "");
  return pasted ? "done" : "refused";
}
