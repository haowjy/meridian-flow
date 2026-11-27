import type { ChromeContext } from "./chrome-context";

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
  docPos: number | null;
  context: ChromeContext;
  insideTextSelection: boolean;
  event: MouseEvent;
};

export type ContextClaimHandler = {
  id: ContextClaimId;
  claim: (target: ContextClaimTarget) => boolean;
};

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
