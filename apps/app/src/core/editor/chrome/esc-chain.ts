import { type ChromeContext, DOCUMENT_CHROME_CONTEXT } from "./chrome-context";

export type GesturePhase = "idle" | "drag" | "sweep";

/**
 * What the kernel knows about one open transient surface, and the identity
 * every other seam names it by.
 *
 * `openLayer` mints one per open layer and hands it back; `chrome.layers`
 * holds those same objects, so a token is compared by identity rather than by
 * its id. That is what lets a layer's keys say which layer they belong to: the
 * merge asks whether this exact surface is still open, and a token missing
 * from the list is a surface already out of the walk home.
 */
export type ChromeLayer = {
  readonly id: string;
  readonly ownerId: string;
};

export type EscSituation = {
  gesture: GesturePhase;
  layers: readonly ChromeLayer[];
  context: ChromeContext;
};

export type EscStep =
  | { kind: "cancel-gesture"; gesture: "drag" | "sweep" }
  | { kind: "close-layer"; layerId: string }
  | { kind: "select-object"; pos: number }
  | { kind: "caret-after-block"; pos: number }
  /** Already home. The kernel must let the key through untouched. */
  | { kind: "at-home" };

export function escStep(situation: EscSituation): EscStep {
  if (situation.gesture !== "idle") {
    return { kind: "cancel-gesture", gesture: situation.gesture };
  }

  const topmost = situation.layers[situation.layers.length - 1];
  if (topmost) return { kind: "close-layer", layerId: topmost.id };

  const { owner, pos, objectPos } = situation.context;
  if ((owner === "source-block" || owner === "object") && pos !== null) {
    return { kind: "caret-after-block", pos };
  }

  // Prose inside an object (a table cell) is one step further from home than
  // prose in the document: leaving the sentence comes before leaving the table.
  if (objectPos !== null) return { kind: "select-object", pos: objectPos };

  return { kind: "at-home" };
}

export function advanceEscSituation(situation: EscSituation, step: EscStep): EscSituation {
  switch (step.kind) {
    case "cancel-gesture":
      return { ...situation, gesture: "idle" };
    case "close-layer":
      return { ...situation, layers: situation.layers.slice(0, -1) };
    case "select-object":
      return {
        ...situation,
        context: {
          owner: "object",
          nodeType: situation.context.nodeType,
          objectSpec: situation.context.objectSpec,
          pos: step.pos,
          chain: ["document", "object"],
          objectPos: null,
        },
      };
    case "caret-after-block":
      return { ...situation, context: DOCUMENT_CHROME_CONTEXT };
    case "at-home":
      return situation;
  }
}
