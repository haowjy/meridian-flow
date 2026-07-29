import { describe, expect, it } from "vitest";

import type { ChromeContext } from "./chrome-context";
import { DOCUMENT_CHROME_CONTEXT } from "./chrome-context";
import {
  advanceEscSituation,
  type EscSituation,
  escStep,
  escWalkHome,
  type GesturePhase,
} from "./esc-chain";

const objectContext: ChromeContext = {
  owner: "object",
  nodeType: "figure",
  pos: 12,
  chain: ["document", "object"],
  objectPos: null,
};

const sourceContext: ChromeContext = {
  owner: "source-block",
  nodeType: "code_block",
  pos: 12,
  chain: ["document", "source-block"],
  objectPos: null,
};

const cellContext: ChromeContext = {
  owner: "table-cell",
  nodeType: "table_cell",
  pos: 30,
  // The table around the cell: Esc's first step out of a cell is onto it.
  chain: ["document", "table", "table-cell"],
  objectPos: 24,
};

const situation = (overrides: Partial<EscSituation> = {}): EscSituation => ({
  gesture: "idle",
  layers: [],
  context: DOCUMENT_CHROME_CONTEXT,
  ...overrides,
});

describe("escStep", () => {
  it("cancels a gesture before anything else, however deep the chrome is", () => {
    const step = escStep(
      situation({
        gesture: "drag",
        layers: [{ id: "diagram-dialog" }, { id: "diagram-source" }],
        context: objectContext,
      }),
    );

    expect(step).toEqual({ kind: "cancel-gesture", gesture: "drag" });
  });

  it("closes the topmost layer, not the one that opened first", () => {
    const step = escStep(
      situation({ layers: [{ id: "diagram-dialog" }, { id: "diagram-source" }] }),
    );

    expect(step).toEqual({ kind: "close-layer", layerId: "diagram-source" });
  });

  it("drops the caret after a selected object", () => {
    expect(escStep(situation({ context: objectContext }))).toEqual({
      kind: "caret-after-block",
      pos: 12,
    });
  });

  it("leaves a code block for the caret after it, the design's stated exception", () => {
    expect(escStep(situation({ context: sourceContext }))).toEqual({
      kind: "caret-after-block",
      pos: 12,
    });
  });

  it("is already home in prose, so the key stays available to the browser", () => {
    expect(escStep(situation())).toEqual({ kind: "at-home" });
  });

  it("steps out of a table cell onto the table before leaving it", () => {
    const selectTable = escStep(situation({ context: cellContext }));
    expect(selectTable).toEqual({ kind: "select-object", pos: 24 });

    // And the second Esc leaves the table the first one selected.
    const selected = advanceEscSituation(situation({ context: cellContext }), selectTable);
    expect(escStep(selected)).toEqual({ kind: "caret-after-block", pos: 24 });
  });
});

describe("the walk home", () => {
  const gestures: GesturePhase[] = ["idle", "drag", "sweep"];
  const layerStacks = [
    [],
    [{ id: "menu" }],
    [{ id: "dialog" }, { id: "source" }],
    [{ id: "dialog" }, { id: "source" }, { id: "menu" }],
  ];
  const contexts = [DOCUMENT_CHROME_CONTEXT, objectContext, sourceContext, cellContext];

  it("reaches home from every constructed state, one step at a time", () => {
    for (const gesture of gestures) {
      for (const layers of layerStacks) {
        for (const context of contexts) {
          const start = situation({ gesture, layers, context });
          const steps = escWalkHome(start);

          // One step per thing standing between the writer and the page: the
          // gesture, each layer, the object the caret is inside, and the
          // object it is standing on.
          const expected =
            (gesture === "idle" ? 0 : 1) +
            layers.length +
            (context.owner === "object" || context.owner === "source-block" ? 1 : 0) +
            (context.objectPos === null ? 0 : 2);
          expect(steps).toHaveLength(expected);

          const home = steps.reduce(advanceEscSituation, start);
          expect(escStep(home)).toEqual({ kind: "at-home" });
        }
      }
    }
  });

  it("never repeats a step, so no state can trap a writer in a loop", () => {
    const start = situation({
      gesture: "sweep",
      layers: [{ id: "dialog" }, { id: "source" }],
      context: objectContext,
    });

    const seen = escWalkHome(start).map((step) => JSON.stringify(step));
    expect(new Set(seen).size).toBe(seen.length);
  });
});
