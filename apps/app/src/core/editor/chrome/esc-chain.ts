/**
 * Esc walks home (law 3): one key, one step, one direction, from anywhere.
 *
 * The kernel owns the chain; surfaces own only their own dismissal. A surface
 * registers itself as a layer while it is open and the chain decides when its
 * turn comes, so no surface has to know what else might be above or below it —
 * which is the only way "nobody is ever trapped" can be a property of the
 * editor rather than a hope about every lane.
 *
 * The three-step walk law 3 spells out (source → object selected → caret after
 * the object) is not three cases here. A diagram's source room is a pane inside
 * its dialog, so both are layers: closing the source pane lands on the viewer,
 * closing the viewer lands on the page with the object still selected, and the
 * next Esc drops the caret after it. A code block is the design's stated
 * exception (§5.3) — its rendering IS its source, so there is no room to leave
 * and Esc goes straight to the caret after the block.
 *
 * An object whose insides are prose walks the same three steps with a
 * different first one: a caret in a table cell is standing INSIDE the object,
 * so Esc selects the table, and only the next Esc leaves it.
 *
 * Pure. `escStep` decides; the caller performs. `advanceEscSituation` models
 * the performance so the chain can be proved terminating without an editor.
 */

import { type ChromeContext, DOCUMENT_CHROME_CONTEXT } from "./chrome-context";

/** A pointer gesture in flight. Esc cancels it before anything else (§5.8). */
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
};

export type EscSituation = {
  gesture: GesturePhase;
  /** Open transient layers in open order; the last one is topmost. */
  layers: readonly ChromeLayer[];
  context: ChromeContext;
};

export type EscStep =
  | { kind: "cancel-gesture"; gesture: "drag" | "sweep" }
  | { kind: "close-layer"; layerId: string }
  /** Select the object the caret is standing inside, leaving its prose. */
  | { kind: "select-object"; pos: number }
  /** Put the caret immediately after the block at `pos` and select nothing. */
  | { kind: "caret-after-block"; pos: number }
  /** Already home. The kernel must let the key through untouched. */
  | { kind: "at-home" };

/**
 * The one step home from here. Never more than one, never zero: `at-home` is a
 * real answer, and it is the answer that keeps Esc available to the browser
 * (a composition, an IME, a native dialog) once the editor has nothing to give
 * back.
 */
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

/**
 * The situation after `step` has been performed, modelling what each step does
 * to the editor. Its job is the walk-home proof: apply `escStep` until it
 * answers `at-home` and every constructed state must get there in a bounded
 * number of steps.
 */
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
      // The caret lands in prose beside the block, which is the document
      // context by definition — a block's next sibling is not inside it.
      return { ...situation, context: DOCUMENT_CHROME_CONTEXT };
    case "at-home":
      return situation;
  }
}
