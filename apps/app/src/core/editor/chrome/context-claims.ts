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
  if (target.event.shiftKey) return null;

  for (const id of CONTEXT_CLAIM_ORDER) {
    for (const handler of handlers) {
      if (handler.id !== id) continue;
      if (handler.claim(target)) return id;
    }
  }
  return null;
}
