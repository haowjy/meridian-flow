/**
 * focus-on-open — a document the writer just made opens with the caret in it.
 *
 * Creating a document (New file, a link's Create) is an invitation to type. The
 * committed open arms its own tab instance, and only the editor mounted for that
 * instance claims the intent, once, when it is live and foreground. Instance ids
 * are minted per open, so an open that failed, was replaced or was closed leaves
 * an id nothing will ever present again; a later open of the same document is a
 * different instance and never inherits it.
 */

const armed = new Set<string>();

/** Called at the moment an open commits, with the tab instance it installed. */
export function armEditorFocus(tabInstanceId: string): void {
  armed.add(tabInstanceId);
}

/** True once, for the editor of the armed tab instance. */
export function claimEditorFocus(tabInstanceId: string | undefined): boolean {
  return tabInstanceId !== undefined && armed.delete(tabInstanceId);
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
