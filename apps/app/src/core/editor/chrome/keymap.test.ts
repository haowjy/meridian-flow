import type { EditorState } from "@tiptap/pm/state";
import { describe, expect, it, vi } from "vitest";

import { DOCUMENT_CHROME_CONTEXT } from "./chrome-context";
import type { ChromeLayer } from "./esc-chain";
import {
  assertKeymapContribution,
  type KeymapApplicability,
  type KeymapContribution,
  keymapScopeApplies,
  mergeKeymapContributions,
} from "./keymap";

const state = {} as EditorState;

/**
 * Layer tokens the way the kernel hands them out: shallowest first, compared by
 * identity. A test builds the stack it is about and names the same objects in
 * the contributions, which is exactly what `chrome.layers` and `openLayer` do.
 */
const dialog: ChromeLayer = { id: "diagram-dialog" };
const pane: ChromeLayer = { id: "diagram-source" };

/** Every scope live at once, so the ladder tests measure order, not scope. */
const anywhere = (): KeymapApplicability => ({
  context: { ...DOCUMENT_CHROME_CONTEXT, owner: "object", chain: ["document", "table", "object"] },
  layers: [dialog],
});

function contribution(
  id: string,
  scope: Exclude<KeymapContribution["scope"], "layer">,
  handled: boolean,
): KeymapContribution & { run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(() => handled);
  return { id, scope, bindings: { "Alt-ArrowUp": run }, run };
}

function layerContribution(
  id: string,
  layer: ChromeLayer | null,
  handled: boolean,
): KeymapContribution & { run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(() => handled);
  return { id, scope: "layer", layer, bindings: { "Alt-ArrowUp": run }, run };
}

describe("mergeKeymapContributions", () => {
  it("gives the key to the deepest owner first (law 4)", () => {
    const layer = layerContribution("slash", dialog, true);
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

describe("nested layers", () => {
  /** A dialog with its source pane open inside it, which is the design's own path. */
  const nested = (): KeymapApplicability => ({ ...anywhere(), layers: [dialog, pane] });

  it("gives the chord to the deepest open layer, whichever registered first", () => {
    // The dialog opens and registers, then the pane it opens inside itself does.
    // Arrival order says the dialog; depth says the pane. React makes the
    // reverse order just as ordinary — child effects run before parent ones —
    // so neither order may decide this.
    const dialogKeys = layerContribution("diagram-dialog", dialog, true);
    const paneKeys = layerContribution("diagram-source", pane, true);

    const arrivedInDepthOrder = mergeKeymapContributions([dialogKeys, paneKeys], nested);
    expect(arrivedInDepthOrder["Alt-ArrowUp"](state)).toBe(true);
    expect(paneKeys.run).toHaveBeenCalledOnce();
    expect(dialogKeys.run).not.toHaveBeenCalled();

    const arrivedReversed = mergeKeymapContributions([paneKeys, dialogKeys], nested);
    expect(arrivedReversed["Alt-ArrowUp"](state)).toBe(true);
    expect(paneKeys.run).toHaveBeenCalledTimes(2);
    expect(dialogKeys.run).not.toHaveBeenCalled();
  });

  it("drops a chord past every layer when the deepest one declines", () => {
    // A decline is about this key, not about handing it to the surface behind:
    // the writer cannot reach the dialog while its own pane is open.
    const dialogKeys = layerContribution("diagram-dialog", dialog, true);
    const paneKeys = layerContribution("diagram-source", pane, false);
    const blocks = contribution("blocks", "block", true);
    const merged = mergeKeymapContributions([dialogKeys, paneKeys, blocks], nested);

    expect(merged["Alt-ArrowUp"](state)).toBe(true);
    expect(paneKeys.run).toHaveBeenCalledOnce();
    expect(dialogKeys.run).not.toHaveBeenCalled();
    expect(blocks.run).toHaveBeenCalledOnce();
  });

  it("stops offering a layer's keys once that layer has closed", () => {
    // The pane released and the dialog around it is still open, so layer scope
    // is live and the pane's keys are not.
    const paneKeys = layerContribution("diagram-source", pane, true);
    const merged = mergeKeymapContributions([paneKeys], anywhere);

    expect(merged["Alt-ArrowUp"](state)).toBe(false);
    expect(paneKeys.run).not.toHaveBeenCalled();
  });

  it("answers keys that name no layer only when no open layer claims them", () => {
    // The suggestion menus' case: the trigger registers the arrow keys a beat
    // before React opens the popover that becomes their layer.
    const menuKeys = layerContribution("slash-menu", null, true);
    const dialogKeys = layerContribution("diagram-dialog", dialog, true);

    const alone = mergeKeymapContributions([menuKeys], anywhere);
    expect(alone["Alt-ArrowUp"](state)).toBe(true);
    expect(menuKeys.run).toHaveBeenCalledOnce();

    const contested = mergeKeymapContributions([menuKeys, dialogKeys], anywhere);
    expect(contested["Alt-ArrowUp"](state)).toBe(true);
    expect(dialogKeys.run).toHaveBeenCalledOnce();
    expect(menuKeys.run).toHaveBeenCalledOnce();
  });
});

describe("reach", () => {
  it("hands portalled focus only the contributions that reach that far", () => {
    const dialogKeys = {
      ...layerContribution("diagram-dialog", dialog, true),
      reach: "chrome" as const,
    };
    const slash = layerContribution("slash-menu", null, true);

    const beyondProse = mergeKeymapContributions([slash, dialogKeys], anywhere, "chrome");
    expect(beyondProse["Alt-ArrowUp"](state)).toBe(true);
    expect(dialogKeys.run).toHaveBeenCalledOnce();
    // The slash menu's keys belong to a caret in the prose. Answering them from
    // wherever focus happens to be would take them from the chat composer.
    expect(slash.run).not.toHaveBeenCalled();
  });

  it("still runs a chrome-reach contribution from the prose", () => {
    const dialogKeys = {
      ...layerContribution("diagram-dialog", dialog, true),
      reach: "chrome" as const,
    };

    expect(mergeKeymapContributions([dialogKeys], anywhere)["Alt-ArrowUp"](state)).toBe(true);
    expect(dialogKeys.run).toHaveBeenCalledOnce();
  });
});

describe("keymap scopes", () => {
  const inProse: KeymapApplicability = { context: DOCUMENT_CHROME_CONTEXT, layers: [] };

  it("holds a layer scope back until a surface is open", () => {
    expect(keymapScopeApplies("layer", inProse)).toBe(false);
    expect(keymapScopeApplies("layer", { ...inProse, layers: [dialog] })).toBe(true);
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
        layers: [],
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
        layers: [],
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
      layers: [],
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
        layer: dialog,
        bindings: { Escape: () => true },
      }),
    ).toThrow(/Esc chain owns it/);
  });

  it("names the lane, so the refusal reaches whoever wrote the binding", () => {
    expect(() =>
      assertKeymapContribution({
        id: "slash-menu",
        scope: "layer",
        layer: null,
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

  it("refuses a key another lane already owns in the same place", () => {
    const registered = [contribution("tab-indent", "document", true)];

    expect(() =>
      assertKeymapContribution(contribution("rival-lane", "document", true), registered),
    ).toThrow(/where "tab-indent" already has it/);
  });

  it("leaves a narrowed pair alone: that chain is the design", () => {
    const registered: KeymapContribution[] = [
      { id: "tab-fence", scope: "block", appliesTo: () => true, bindings: { Tab: () => true } },
    ];

    expect(() =>
      assertKeymapContribution(
        { id: "tab-indent", scope: "block", bindings: { Tab: () => true } },
        registered,
      ),
    ).not.toThrow();
    expect(() =>
      assertKeymapContribution(
        { id: "tab-list", scope: "block", appliesTo: () => true, bindings: { Tab: () => true } },
        [{ id: "tab-indent", scope: "block", bindings: { Tab: () => true } }],
      ),
    ).not.toThrow();
  });

  it("leaves two lanes at different scopes alone: the ladder orders them", () => {
    expect(() =>
      assertKeymapContribution(contribution("tab-indent", "document", true), [
        contribution("tab-table", "table", true),
      ]),
    ).not.toThrow();
  });

  it("leaves two layers alone, and two lanes that named no layer", () => {
    // Depth orders nested layers, and a contribution with no token has no place
    // to collide in — which is what lets both suggestion lanes spell ArrowDown.
    expect(() =>
      assertKeymapContribution(layerContribution("diagram-source", pane, true), [
        layerContribution("diagram-dialog", dialog, true),
      ]),
    ).not.toThrow();
    expect(() =>
      assertKeymapContribution(layerContribution("wikilink-menu", null, true), [
        layerContribution("slash-menu", null, true),
      ]),
    ).not.toThrow();
  });

  it("still refuses one layer claiming its own key twice", () => {
    expect(() =>
      assertKeymapContribution(layerContribution("diagram-dialog", dialog, true), [
        layerContribution("diagram-dialog", dialog, true),
      ]),
    ).toThrow(/Alt-ArrowUp/);
  });
});
