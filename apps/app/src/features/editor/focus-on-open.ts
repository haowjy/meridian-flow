/**
 * focus-on-open — a document the writer just made opens with the caret in it.
 *
 * Creating a document (New file, a link's Create) is an invitation to type. The
 * navigation that opens it arms one intent when it commits, and the editor that
 * mounts for the document claims it once it is live and foreground. Every new
 * navigation retires what the last one armed, so a create that failed, was
 * superseded or was left before its editor mounted never focuses a later open.
 */

let armed: string | null = null;

/** Called by the navigation owner at the moment it commits the document's destination. */
export function armEditorFocus(documentId: string): void {
  armed = documentId;
}

/** Called when a navigation starts, fails or is cancelled: its predecessor's intent is spent. */
export function retireEditorFocus(): void {
  armed = null;
}

/** True once, for the editor whose document was armed. `matches` canonicalizes ids across a join. */
export function claimEditorFocus(matches: (documentId: string) => boolean): boolean {
  if (armed === null || !matches(armed)) return false;
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
