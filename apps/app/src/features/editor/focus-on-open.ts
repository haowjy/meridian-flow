/**
 * focus-on-open — a document the writer just made opens with the caret in it, and so
 * does main's first document after a page load.
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

/**
 * A page load gives main's document the caret to the document it shows, so the writer's
 * first keys land in the text rather than in the side panel's chat. Held from the load
 * until the writer takes the focus (a key, a press, focus placed anywhere else, even
 * before an editor has painted); not on a touch screen, where focusing a text opens the
 * on-screen keyboard over it. Editors join as they paint and leave as they unmount.
 */
const loadEditors = new Set<Editor>();
let loadFocusOpen =
  typeof window !== "undefined" && !window.matchMedia?.("(pointer: coarse)").matches;
if (loadFocusOpen) {
  holdFocus(shownLoadEditor, () => {
    loadFocusOpen = false;
    loadEditors.clear();
  });
}

/** The registered editor that is on screen: a warm copy mounts hidden or inert beside it. */
function shownLoadEditor(): HTMLElement | null {
  for (const editor of loadEditors) {
    const dom = editor.isDestroyed ? null : editor.view.dom;
    if (dom && dom.getClientRects().length > 0 && !dom.closest("[inert]")) return dom;
  }
  return null;
}

/** Joins `editor` to the load's hold while it can still take the caret; returns its leave. */
export function focusOnLoad(editor: Editor): () => void {
  if (!loadFocusOpen) return () => {};
  loadEditors.add(editor);
  if (focusIsFree()) shownLoadEditor()?.focus();
  return () => loadEditors.delete(editor);
}
