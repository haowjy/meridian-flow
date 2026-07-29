import { describe, expect, it, vi } from "vitest";

import type { ChromeContext } from "./chrome-context";
import { DOCUMENT_CHROME_CONTEXT } from "./chrome-context";
import {
  type ContextClaimHandler,
  type ContextClaimId,
  type ContextClaimTarget,
  resolveContextClaim,
} from "./context-claims";

const objectContext: ChromeContext = {
  owner: "object",
  nodeType: "figure",
  pos: 8,
  chain: ["document", "object"],
};

function target(overrides: Partial<ContextClaimTarget> = {}): ContextClaimTarget {
  return {
    element: { dataset: {} } as unknown as HTMLElement,
    docPos: 4,
    context: DOCUMENT_CHROME_CONTEXT,
    insideTextSelection: false,
    event: {} as MouseEvent,
    ...overrides,
  };
}

/** A lane's registration, spelled the way a lane will spell it. */
function claimant(id: ContextClaimId, matches: (t: ContextClaimTarget) => boolean) {
  return { id, claim: vi.fn(matches) } satisfies ContextClaimHandler;
}

describe("the right-click claim table", () => {
  const link = claimant("link", (t) => t.element.dataset.link === "true");
  const selection = claimant("text-selection", (t) => t.insideTextSelection);
  const grip = claimant("grip", (t) => t.element.dataset.grip === "true");
  const object = claimant("object", (t) => t.context.owner === "object");
  const all = [object, grip, selection, link];

  it("leaves the bare caret to the browser, so spellcheck survives (ruling 11)", () => {
    expect(resolveContextClaim(all, target())).toBeNull();
  });

  it("claims a non-empty prose selection the pointer is inside", () => {
    expect(resolveContextClaim(all, target({ insideTextSelection: true }))).toBe("text-selection");
  });

  it("claims an object", () => {
    expect(resolveContextClaim(all, target({ context: objectContext }))).toBe("object");
  });

  it("claims a table grip over the object it belongs to", () => {
    const gripTarget = target({
      element: { dataset: { grip: "true" } } as unknown as HTMLElement,
      context: objectContext,
    });
    expect(resolveContextClaim(all, gripTarget)).toBe("grip");
  });

  it("gives a link inside a selection to the link: the deepest context wins", () => {
    const linkTarget = target({
      element: { dataset: { link: "true" } } as unknown as HTMLElement,
      insideTextSelection: true,
    });
    expect(resolveContextClaim(all, linkTarget)).toBe("link");
  });

  it("beats an object with a selection the pointer sits inside", () => {
    // The Ctrl+A case: the selection spans the figure and the pointer is on
    // it. §5.1 ranks the selection above the object, so formatting wins.
    const spanning = target({ context: objectContext, insideTextSelection: true });
    expect(resolveContextClaim(all, spanning)).toBe("text-selection");
  });

  it("resolves by the ladder, never by registration order", () => {
    const registeredLast = [object, link];
    const linkTarget = target({
      element: { dataset: { link: "true" } } as unknown as HTMLElement,
      context: objectContext,
    });
    expect(resolveContextClaim(registeredLast, linkTarget)).toBe("link");
  });

  it("falls through to the browser when the only claimant declines", () => {
    const declining = claimant("object", () => false);
    expect(resolveContextClaim([declining], target({ context: objectContext }))).toBeNull();
    expect(declining.claim).toHaveBeenCalledOnce();
  });

  it("stops asking once a rung claims", () => {
    const linkTarget = target({
      element: { dataset: { link: "true" } } as unknown as HTMLElement,
      insideTextSelection: true,
    });
    resolveContextClaim(all, linkTarget);
    expect(selection.claim).not.toHaveBeenCalledWith(linkTarget);
  });
});
