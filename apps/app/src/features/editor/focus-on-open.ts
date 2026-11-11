/**
 * focus-on-open — a document the writer just made opens with the caret in it.
 *
 * Creating a document (New file, a link's Create) is an invitation to type. The
 * committed open arms its document, and only the editor of that document claims
 * the intent, once, when it is live and foreground. One open is armed at a time:
 * a later open replaces the intent, so an open that failed or was replaced never
 * focuses a later one of the same document.
 */

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
