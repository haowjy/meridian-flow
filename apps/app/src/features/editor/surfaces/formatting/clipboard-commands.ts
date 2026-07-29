/**
 * Cut, Copy, and Paste for a menu item, which is a different problem from the
 * same three keys.
 *
 * A keystroke arrives as a clipboard event and ProseMirror handles it. A menu
 * item arrives with focus inside a portalled menu and no event to read, so the
 * clipboard has to be reached through `navigator.clipboard` and the document
 * through the view's own serializer. Using that serializer is what makes a
 * copy paste back as structure rather than as flattened text: it writes both
 * `text/html` (carrying ProseMirror's slice depths) and `text/plain`.
 *
 * Every one of these can be refused by the browser rather than by the
 * document, and a refusal has to reach the writer (law 5). So each returns
 * what happened, and the surface greys the control with its shortcut once a
 * browser has said no. Reading is refused far more often than writing — whole
 * browsers withhold it — but a permissions policy can withhold either.
 */

import type { Editor } from "@tiptap/core";

/** Whether a clipboard direction is worth offering before the writer tries it. */
export type ClipboardAvailability = "available" | "unavailable";

export type ClipboardAccess = {
  read: ClipboardAvailability;
  write: ClipboardAvailability;
};

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

/**
 * What the clipboard offers before the writer presses anything. A capability
 * check only: a permission prompt is a fine outcome, so "might be denied" is
 * not a reason to grey a control in advance.
 */
export function clipboardAccess(): ClipboardAccess {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  return {
    read: typeof clipboard?.read === "function" ? "available" : "unavailable",
    write:
      typeof clipboard?.write === "function" || typeof clipboard?.writeText === "function"
        ? "available"
        : "unavailable",
  };
}

export async function copySelection(editor: Editor): Promise<ClipboardResult> {
  if (editor.isDestroyed || editor.state.selection.empty) return "refused";
  const { view } = editor;
  const { dom, text } = view.serializeForClipboard(view.state.selection.content());
  return writeClipboard(dom.innerHTML, text);
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
  if (clipboardAccess().read === "unavailable") return "unavailable";

  let items: readonly ClipboardItem[];
  try {
    items = await navigator.clipboard.read();
  } catch {
    // Denied, dismissed, or a browser that exposes `read` and then refuses it.
    return "denied";
  }
  if (editor.isDestroyed) return "refused";

  const html = await firstClipboardFlavour(items, "text/html");
  const text = html ? null : await firstClipboardFlavour(items, "text/plain");
  if (!html && !text) return "empty";

  // The caret never left the prose; the paste lands where the writer is
  // looking, so focus goes back before the transaction rather than after it.
  editor.commands.focus();
  const pasted = html ? editor.view.pasteHTML(html) : editor.view.pasteText(text ?? "");
  return pasted ? "done" : "refused";
}

async function writeClipboard(html: string, text: string): Promise<ClipboardResult> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (!clipboard) return "unavailable";

  // Both flavours, so a paste back into a manuscript keeps its blocks and a
  // paste into a plain text field still reads as the sentence it was.
  if (typeof clipboard.write === "function" && typeof ClipboardItem === "function") {
    try {
      await clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" }),
        }),
      ]);
      return "done";
    } catch {
      // Fall through: a browser that rejects a two-flavour write may still
      // take the plain one, and losing the marks beats losing the copy.
    }
  }

  if (typeof clipboard.writeText !== "function") return "unavailable";
  try {
    await clipboard.writeText(text);
    return "done";
  } catch {
    return "denied";
  }
}

/**
 * The clipboard's payload for one flavour, verbatim. Emptiness is tested on a
 * trimmed copy and never on the payload itself: a pasted code line's leading
 * indentation and a paragraph's trailing newline are content, and trimming
 * them is a silent edit of what the writer copied.
 */
async function firstClipboardFlavour(
  items: readonly ClipboardItem[],
  type: string,
): Promise<string | null> {
  for (const item of items) {
    if (!item.types.includes(type)) continue;
    const value = await (await item.getType(type)).text();
    if (value.trim()) return value;
  }
  return null;
}
