/**
 * The context-menu claim table: who takes the right-click, and who lets the
 * browser have it.
 *
 * Ruling 11 makes the native menu load-bearing rather than a fallback —
 * spellcheck is where a fiction writer actually reaches, and it lives almost
 * entirely at the bare caret. So the router's default is NOT to claim: a
 * `contextmenu` with no matching rule is left alone, `preventDefault` is never
 * called, and the browser's own menu opens.
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
 */
export const CONTEXT_CLAIM_ORDER = ["link", "text-selection", "grip", "object"] as const;

export type ContextClaimId = (typeof CONTEXT_CLAIM_ORDER)[number];

export type ContextClaimTarget = {
  /** The deepest element under the pointer. */
  element: HTMLElement;
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
  for (const id of CONTEXT_CLAIM_ORDER) {
    for (const handler of handlers) {
      if (handler.id !== id) continue;
      if (handler.claim(target)) return id;
    }
  }
  return null;
}
