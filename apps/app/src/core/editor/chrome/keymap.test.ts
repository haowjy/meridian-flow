import type { EditorState } from "@tiptap/pm/state";
import { describe, expect, it, vi } from "vitest";

import { DOCUMENT_CHROME_CONTEXT } from "./chrome-context";
import {
  assertKeymapContribution,
  type KeymapApplicability,
  type KeymapContribution,
  keymapScopeApplies,
  mergeKeymapContributions,
} from "./keymap";

const state = {} as EditorState;

/** Every scope live at once, so the ladder tests measure order, not scope. */
const anywhere = (): KeymapApplicability => ({
  context: { ...DOCUMENT_CHROME_CONTEXT, owner: "object", chain: ["document", "table", "object"] },
  layerCount: 1,
});

function contribution(
  id: string,
  scope: KeymapContribution["scope"],
  handled: boolean,
): KeymapContribution & { run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(() => handled);
  return { id, scope, bindings: { "Alt-ArrowUp": run }, run };
}

describe("mergeKeymapContributions", () => {
  it("gives the key to the deepest owner first (law 4)", () => {
    const layer = contribution("slash", "layer", true);
    const table = contribution("table", "table", true);
    const merged = mergeKeymapContributions([table, layer], anywhere);

    expect(merged["Alt-ArrowUp"](state)).toBe(true);
    expect(layer.run).toHaveBeenCalledOnce();
    expect(table.run).not.toHaveBeenCalled();
  });

  it("hands the key down when the deeper owner declines", () => {
    const object = contribution("object", "object", false);
    const document = contribution("blocks", "document", true);
    const merged = mergeKeymapContributions([document, object], anywhere);

    expect(merged["Alt-ArrowUp"](state)).toBe(true);
    expect(object.run).toHaveBeenCalledOnce();
    expect(document.run).toHaveBeenCalledOnce();
  });

  it("reports the key unhandled when nobody takes it", () => {
    const merged = mergeKeymapContributions([contribution("table", "table", false)], anywhere);
    expect(merged["Alt-ArrowUp"](state)).toBe(false);
  });
});

describe("reach", () => {
  it("hands portalled focus only the contributions that reach that far", () => {
    const dialog = {
      ...contribution("diagram-dialog", "layer", true),
      reach: "chrome" as const,
    };
    const slash = contribution("slash-menu", "layer", true);

    const beyondProse = mergeKeymapContributions([slash, dialog], anywhere, "chrome");
    expect(beyondProse["Alt-ArrowUp"](state)).toBe(true);
    expect(dialog.run).toHaveBeenCalledOnce();
    // The slash menu's keys belong to a caret in the prose. Answering them from
    // wherever focus happens to be would take them from the chat composer.
    expect(slash.run).not.toHaveBeenCalled();
  });

  it("still runs a chrome-reach contribution from the prose", () => {
    const dialog = {
      ...contribution("diagram-dialog", "layer", true),
      reach: "chrome" as const,
    };

    expect(mergeKeymapContributions([dialog], anywhere)["Alt-ArrowUp"](state)).toBe(true);
    expect(dialog.run).toHaveBeenCalledOnce();
  });
});

describe("keymap scopes", () => {
  const inProse: KeymapApplicability = { context: DOCUMENT_CHROME_CONTEXT, layerCount: 0 };

  it("holds a layer scope back until a surface is open", () => {
    expect(keymapScopeApplies("layer", inProse)).toBe(false);
    expect(keymapScopeApplies("layer", { ...inProse, layerCount: 1 })).toBe(true);
  });

  it("holds an object scope back until an object is selected", () => {
    expect(keymapScopeApplies("object", inProse)).toBe(false);
    expect(
      keymapScopeApplies("object", {
        context: {
          owner: "object",
          nodeType: "figure",
          objectSpec: "figure",
          pos: 4,
          chain: ["document", "object"],
          objectPos: null,
        },
        layerCount: 0,
      }),
    ).toBe(true);
  });

  it("holds a table scope back until the selection is inside a table", () => {
    expect(keymapScopeApplies("table", inProse)).toBe(false);
    expect(
      keymapScopeApplies("table", {
        context: {
          owner: "table-cell",
          nodeType: "table_cell",
          objectSpec: null,
          pos: 9,
          chain: ["document", "table", "table-cell"],
          objectPos: 3,
        },
        layerCount: 0,
      }),
    ).toBe(true);
  });

  it("leaves block and document live everywhere: they are order, not place", () => {
    expect(keymapScopeApplies("block", inProse)).toBe(true);
    expect(keymapScopeApplies("document", inProse)).toBe(true);
  });

  it("drops a contribution the scope admitted but its own narrowing refuses", () => {
    const object: KeymapApplicability = {
      context: {
        owner: "object",
        nodeType: "figure",
        objectSpec: "figure",
        pos: 4,
        chain: ["document", "object"],
        objectPos: null,
      },
      layerCount: 0,
    };
    const diagramOnly = vi.fn(() => true);
    const merged = mergeKeymapContributions(
      [
        {
          id: "object:code_block",
          scope: "object",
          appliesTo: (context) => context.nodeType === "code_block",
          bindings: { "Mod-Enter": diagramOnly },
        },
      ],
      () => object,
    );

    expect(merged["Mod-Enter"](state)).toBe(false);
    expect(diagramOnly).not.toHaveBeenCalled();
  });
});

describe("assertKeymapContribution", () => {
  it("refuses Escape: the walk-home chain owns it, not a surface", () => {
    expect(() =>
      assertKeymapContribution({
        id: "diagram-dialog",
        scope: "layer",
        bindings: { Escape: () => true },
      }),
    ).toThrow(/Esc chain owns it/);
  });

  it("names the lane, so the refusal reaches whoever wrote the binding", () => {
    expect(() =>
      assertKeymapContribution({
        id: "slash-menu",
        scope: "layer",
        bindings: { Escape: () => true },
      }),
    ).toThrow(/"slash-menu"/);
  });

  it("refuses chrome reach outside layer scope: a layer's keys end when it does", () => {
    expect(() =>
      assertKeymapContribution({
        id: "object:code_block",
        scope: "object",
        reach: "chrome",
        bindings: { "Mod-Enter": () => true },
      }),
    ).toThrow(/only a layer's keys/);
  });

  it("passes anything else through", () => {
    expect(() =>
      assertKeymapContribution({
        id: "table",
        scope: "table",
        bindings: { "Alt-ArrowUp": () => true },
      }),
    ).not.toThrow();
  });
});
