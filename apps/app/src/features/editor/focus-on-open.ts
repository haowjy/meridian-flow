/**
 * focus-on-open — a document the writer just made opens with the caret in it, and so
 * does main's document after a page load or an open from a sidebar lying over main.
 *
 * Creating a document (New file, a link's Create) is an invitation to type. The
 * committed open arms its document, and only the editor of that document claims
 * the intent, once, when it is live and foreground. One open is armed at a time:
 * a later open replaces the intent, so an open that failed or was replaced never
 * focuses a later one of the same document.
 */

import type { Editor } from "@tiptap/core";
import { focusIsFree, holdFocus } from "@/lib/focus-follow";

let armed: string | null = null;

/** Called at the moment an open commits, with the document it opened. */
export function armEditorFocus(documentId: string): void {
  armed = documentId;
}

/** True once, for the editor of the armed document. */
export function claimEditorFocus(documentId: string | undefined): boolean {
  if (documentId === undefined || armed !== documentId) return false;
  armed = null;
  return true;
}

/** Main's editors as they paint: a warm copy mounts hidden or inert beside the shown one. */
const mainEditors = new Set<Editor>();

function shownMainEditor(): HTMLElement | null {
  for (const editor of mainEditors) {
    const dom = editor.isDestroyed ? null : editor.view.dom;
    if (dom && dom.getClientRects().length > 0 && !dom.closest("[inert]")) return dom;
  }
  return null;
}

let stopMainFocus: (() => void) | null = null;

/**
 * Main's editor takes the caret where it keeps it, as soon as it shows and whenever the focus
 * falls free, until the writer takes the focus (a key, a press, focus placed anywhere else).
 * A later call replaces an earlier one.
 */
export function focusMainEditor(): void {
  stopMainFocus?.();
  stopMainFocus = holdFocus(shownMainEditor, () => {
    stopMainFocus = null;
  });
}

/**
 * A page load gives main's document the caret, so the writer's first keys land in the text
 * rather than in the side panel's chat; not on a touch screen, where focusing a text opens the
 * on-screen keyboard over it.
 */
if (typeof window !== "undefined" && !window.matchMedia?.("(pointer: coarse)").matches)
  focusMainEditor();

/** Joins `editor`, live and editable, to main's editors; returns its leave. */
export function joinMainEditors(editor: Editor): () => void {
  mainEditors.add(editor);
  if (stopMainFocus && focusIsFree()) shownMainEditor()?.focus();
  return () => mainEditors.delete(editor);
}
