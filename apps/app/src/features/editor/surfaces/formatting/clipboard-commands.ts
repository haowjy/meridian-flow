import type { Editor } from "@tiptap/core";

import { readClipboardText, writeClipboardRichText } from "../../clipboard";

export type ClipboardResult = "done" | "empty" | "unavailable" | "denied" | "refused";

export async function copySelection(editor: Editor): Promise<ClipboardResult> {
  if (editor.isDestroyed || editor.state.selection.empty) return "refused";
  const { view } = editor;
  const { dom, text } = view.serializeForClipboard(view.state.selection.content());
  return (await writeClipboardRichText(dom.innerHTML, text)).status;
}

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

  editor.commands.focus();
  const pasted = held.html
    ? editor.view.pasteHTML(held.html)
    : editor.view.pasteText(held.text ?? "");
  return pasted ? "done" : "refused";
}
