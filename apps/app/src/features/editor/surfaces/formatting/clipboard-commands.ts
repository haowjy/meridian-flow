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
 * Reading is the asymmetric half. Every browser lets a page write to the
 * clipboard from a click; several refuse to let it read (§5.1's honest cost).
 * So paste reports what happened instead of failing quietly, and the surface
 * greys it with the shortcut once a browser has said no.
 */

import type { Editor } from "@tiptap/core";

export type ClipboardReadAvailability = "available" | "unavailable";

export type ClipboardPasteResult =
  /** Content reached the document. */
  | "pasted"
  /** The clipboard held nothing this editor can take. */
  | "empty"
  /** This browser does not expose clipboard reads to the page at all. */
  | "unavailable"
  /** It exposes them and refused this one (permission, or a hostile context). */
  | "denied"
  /** The document would not take the content (read-only, schema). */
  | "refused";

/**
 * Whether Paste can work before the writer presses it. A capability check
 * only: a permission prompt is a fine outcome, so "might be denied" is not a
 * reason to grey the control in advance.
 */
export function clipboardReadAvailability(): ClipboardReadAvailability {
  return typeof navigator !== "undefined" && typeof navigator.clipboard?.read === "function"
    ? "available"
    : "unavailable";
}

export async function copySelection(editor: Editor): Promise<boolean> {
  if (editor.isDestroyed || editor.state.selection.empty) return false;
  const { view } = editor;
  const { dom, text } = view.serializeForClipboard(view.state.selection.content());
  return writeClipboard(dom.innerHTML, text);
}

export async function cutSelection(editor: Editor): Promise<boolean> {
  if (editor.isDestroyed || !editor.isEditable) return false;
  if (!(await copySelection(editor))) return false;
  return editor.chain().focus().deleteSelection().run();
}

export async function pasteIntoSelection(editor: Editor): Promise<ClipboardPasteResult> {
  if (editor.isDestroyed || !editor.isEditable) return "refused";
  if (clipboardReadAvailability() === "unavailable") return "unavailable";

  let items: readonly ClipboardItem[];
  try {
    items = await navigator.clipboard.read();
  } catch {
    // Denied, dismissed, or a browser that exposes `read` and then refuses it.
    return "denied";
  }
  if (editor.isDestroyed) return "refused";

  const html = await firstClipboardText(items, "text/html");
  const text = html ? null : await firstClipboardText(items, "text/plain");
  if (!html && !text) return "empty";

  // The caret never left the prose; the paste lands where the writer is
  // looking, so focus goes back before the transaction rather than after it.
  editor.commands.focus();
  const pasted = html ? editor.view.pasteHTML(html) : editor.view.pasteText(text ?? "");
  return pasted ? "pasted" : "refused";
}

async function writeClipboard(html: string, text: string): Promise<boolean> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (!clipboard) return false;

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
      return true;
    } catch {
      // Fall through: a browser that rejects a two-flavour write still takes
      // the plain one, and losing the marks beats losing the copy.
    }
  }

  if (typeof clipboard.writeText !== "function") return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

async function firstClipboardText(
  items: readonly ClipboardItem[],
  type: string,
): Promise<string | null> {
  for (const item of items) {
    if (!item.types.includes(type)) continue;
    const value = (await (await item.getType(type)).text()).trim();
    if (value) return value;
  }
  return null;
}
