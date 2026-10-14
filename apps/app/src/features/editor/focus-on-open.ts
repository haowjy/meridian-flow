/**
 * focus-on-open — a document the writer just made opens with the caret in it.
 *
 * Creating a document (New file, a link's Create, a new tab) is an invitation to
 * type. The creator names the document; the editor that mounts for it takes the
 * request once it is live and foreground. Held in memory only, and only until
 * that editor claims it: a request nobody claims is dropped by the next one.
 */

const requested = new Set<string>();
const MAX_PENDING = 8;

export function requestEditorFocus(documentId: string): void {
  requested.add(documentId);
  // An abandoned request must not later steal focus for a document opened another way.
  while (requested.size > MAX_PENDING) {
    const oldest = requested.values().next().value;
    if (oldest === undefined) break;
    requested.delete(oldest);
  }
}

/** True once, for the editor whose document was requested. `matches` canonicalizes ids across a join. */
export function claimEditorFocus(matches: (documentId: string) => boolean): boolean {
  for (const id of requested) {
    if (!matches(id)) continue;
    requested.delete(id);
    return true;
  }
  return false;
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
