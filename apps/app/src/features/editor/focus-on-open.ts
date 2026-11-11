/**
 * focus-on-open — a document the writer just made opens with the caret in it, and so
 * does the Editor's first document after a page load.
 *
 * Creating a document (New file, a link's Create) is an invitation to type. The
 * committed open arms its own tab instance, and only the editor mounted for that
 * instance claims the intent, once, when it is live and foreground. Instance ids
 * are minted per open, so an open that failed, was replaced or was closed leaves
 * an id nothing will ever present again; a later open of the same document is a
 * different instance and never inherits it.
 */

import type { Editor } from "@tiptap/core";

const armed = new Set<string>();

/**
 * A page load into the Editor gives the caret to the first document it shows, so the
 * writer's first keys land in the text rather than in the side panel's chat. Open until
 * the writer's first key or press: from then on, focus is theirs to place.
 */
let loadFocusOpen = typeof window !== "undefined";
const stopOnInput = new Set<() => void>();
if (loadFocusOpen) {
  const close = () => {
    loadFocusOpen = false;
    for (const stop of stopOnInput) stop();
    stopOnInput.clear();
    window.removeEventListener("keydown", close, true);
    window.removeEventListener("pointerdown", close, true);
  };
  window.addEventListener("keydown", close, true);
  window.addEventListener("pointerdown", close, true);
}

/** Called at the moment an open commits, with the tab instance it installed. */
export function armEditorFocus(tabInstanceId: string): void {
  armed.add(tabInstanceId);
}

/** True once, for the editor of the armed tab instance. */
export function claimEditorFocus(tabInstanceId: string | undefined): boolean {
  return tabInstanceId !== undefined && armed.delete(tabInstanceId);
}

/**
 * Gives `editor` the caret where it keeps it while it is the Editor's shown document after a
 * page load and nothing else holds focus. Until the writer's first key or press it puts the
 * caret back whenever focus falls free: the shown editor can be swapped in, or rebound,
 * after the paint cover lifts, and a warm copy mounts hidden or inert beside it. Not on a
 * touch screen: focusing a text there opens the on-screen keyboard over it.
 */
export function focusOnLoad(editor: Editor): void {
  if (!loadFocusOpen || window.matchMedia?.("(pointer: coarse)").matches) return;
  const dom = editor.view.dom;
  const settle = () => {
    if (!loadFocusOpen || editor.isDestroyed) return true;
    if (focusIsFree() && dom.getClientRects().length > 0 && !dom.closest("[inert]"))
      editor.view.focus();
    return false;
  };
  if (settle()) return;
  const observer = new MutationObserver(() => {
    if (settle()) observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  stopOnInput.add(() => observer.disconnect());
}

/** Focus may land only while nobody else holds it: a dialog or input that stays open keeps its caret. */
export function focusIsFree(): boolean {
  const active = document.activeElement;
  return (
    !active ||
    active === document.body ||
    !active.isConnected ||
    // The paint cover parks focus on its status line while it stands in for an editor.
    active.hasAttribute("data-paint-status")
  );
}
