/**
 * The context-menu claim table: which editor menu takes the right-click, and
 * the one gesture that gives it back to the browser.
 *
 * Every right-click inside the editor opens an editor menu, and the context
 * picks which one (human ruling, 2026-07-29, superseding ruling 11's fall
 * through to the browser at a bare caret). A writer who right-clicked in a
 * table cell and got the browser's list of nothing they wanted is what settled
 * it: the editor's verbs are the answer the gesture is asking for.
 *
 * The browser's menu is still reachable, and reachable deliberately:
 * **Shift+right-click is never claimed**. Spellcheck suggestions, lookup, and
 * OS services exist in the native menu and nowhere else, so the escape has to
 * be a gesture rather than an absence of one.
 *
 * The decision must be synchronous, inside the `contextmenu` event, because
 * `preventDefault` after the event has returned does nothing. Opening the
 * claimed surface may be deferred a tick; deciding may not.
 *
 * Pure. The runtime kernel owns the DOM listener and calls `resolveContextClaim`.
 */

import type { ChromeContext } from "./chrome-context";

/**
 * Claim precedence, strongest first (§5.1's ownership split). A link inside a
 * selection is still a link — the deepest context wins — so `link` leads.
 *
 * `grip` and `object` are one entry in the design ("object/grip"): they never
 * both match, because a grip is chrome drawn outside the frame and an object
 * is a node inside it. Grip is spelled first as the more specific of the two,
 * so a future grip drawn OVER its table still resolves to the grip.
 *
 * `cell-selection` is second to last because it is the widest selection: a
 * rectangle of table cells the writer swept by hand. A link inside one is
 * still a link, a grip over one is still a grip, and the rung exists because
 * nothing above it wants a `CellSelection` — `text-selection` admits
 * `TextSelection` and `AllSelection` only, which left a swept rectangle with
 * no menu at all.
 *
 * `caret` is the floor, and it matches everywhere the rungs above it declined:
 * a caret in prose, in a table cell, or in a code fence. It is a rung rather
 * than a kernel default because WHICH menu opens is the owning lane's answer,
 * and the lanes are disjoint by context — the formatting menu takes prose and
 * cells, the fence takes its own.
 */
export const CONTEXT_CLAIM_ORDER = [
  "link",
  "text-selection",
  "grip",
  "object",
  "cell-selection",
  "caret",
] as const;

export type ContextClaimId = (typeof CONTEXT_CLAIM_ORDER)[number];

export type ContextClaimTarget = {
  /**
   * The deepest element under the pointer. `Element`, not `HTMLElement`: a
   * mermaid diagram is SVG and so is every icon glyph in an overlay row, and
   * both are exactly what a writer right-clicks. `closest()` works either way.
   */
  element: Element;
  /** Document position under the pointer; null when the pointer left the prose. */
  docPos: number | null;
  /** Deepest context at the pointer, resolved by `resolveChromeContext`. */
  context: ChromeContext;
  /**
   * The pointer sits inside a non-empty text selection.
   *
   * Not merely "a selection exists": §5.1 claims the menu for a selection the
   * writer right-clicked ON. A selection three paragraphs above the pointer is
   * not what the writer is pointing at, and shadowing the native menu there
   * would spend spellcheck on nothing.
   */
  insideTextSelection: boolean;
  event: MouseEvent;
};

export type ContextClaimHandler = {
  id: ContextClaimId;
  /**
   * Synchronous. Return true to take the menu — the router has already
   * decided precedence, so a handler that returns true owns the event and the
   * native menu is suppressed. Opening the surface here is fine; so is
   * scheduling it, as long as the answer comes back now.
   */
  claim: (target: ContextClaimTarget) => boolean;
};

/**
 * Walk the ladder and give the event to the first registered claimant that
 * takes it. `null` means nobody claimed and the browser keeps its menu.
 *
 * Several handlers may register the same id (two lanes, one surface kind);
 * they are tried in registration order within the id.
 */
export function resolveContextClaim(
  handlers: readonly ContextClaimHandler[],
  target: ContextClaimTarget,
): ContextClaimId | null {
  // The escape to the browser's own menu, above the ladder rather than inside
  // it: spellcheck suggestions live nowhere else, and a rung that forgot to
  // check would take the only door to them away.
  if (target.event.shiftKey) return null;

  for (const id of CONTEXT_CLAIM_ORDER) {
    for (const handler of handlers) {
      if (handler.id !== id) continue;
      if (handler.claim(target)) return id;
    }
  }
  return null;
}
