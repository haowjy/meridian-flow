/**
 * The keymap ladder as three tables: who answers a chord, where a scope is
 * live, and what registration refuses.
 *
 * Rows rather than blocks on purpose. This suite is the sole owner of the
 * decision — `ChromeKernelExtension.test.ts` proves the kernel installs it and
 * nothing more — so a new scope, layer arrangement, or reach belongs here as
 * one row, and the row's `ran` list says which owners the chord reached and in
 * what order.
 */
import type { EditorState } from "@tiptap/pm/state";
import { describe, expect, it, vi } from "vitest";

import { type ChromeContext, DOCUMENT_CHROME_CONTEXT } from "./chrome-context";
import type { ChromeLayer } from "./esc-chain";
import {
  assertKeymapContribution,
  type KeymapApplicability,
  type KeymapContribution,
  type KeymapReach,
  type KeymapScope,
  keymapScopeApplies,
  mergeKeymapContributions,
} from "./keymap";

const state = {} as EditorState;

/** The one chord every row presses, so a row measures the ladder and not a key. */
const CHORD = "Alt-ArrowUp";

/**
 * Layer tokens the way the kernel hands them out: shallowest first, compared by
 * identity. A row builds the stack it is about and names the same objects in
 * its contributions, which is exactly what `chrome.layers` and `openLayer` do.
 */
const dialog: ChromeLayer = { id: "diagram-dialog" };
const pane: ChromeLayer = { id: "diagram-source" };

const objectContext: ChromeContext = {
  owner: "object",
  nodeType: "figure",
  objectSpec: "figure",
  pos: 4,
  chain: ["document", "object"],
  objectPos: null,
};

const cellContext: ChromeContext = {
  owner: "table-cell",
  nodeType: "table_cell",
  objectSpec: null,
  pos: 9,
  chain: ["document", "table", "table-cell"],
  objectPos: 3,
};

/** Every scope live at once, so the ladder rows measure order, not scope. */
const ANYWHERE: ChromeContext = {
  ...DOCUMENT_CHROME_CONTEXT,
  owner: "object",
  chain: ["document", "table", "object"],
};

/** A lane's registration, spelled the way a lane spells it, minus the body. */
type Lane = {
  id: string;
  scope: KeymapScope;
  /** Required at layer scope; `null` is the token a lane has before its popover. */
  layer?: ChromeLayer | null;
  reach?: KeymapReach;
  appliesTo?: (context: ChromeContext) => boolean;
  /** What the lane's binding returns: true consumes the chord, false hands it down. */
  handles: boolean;
};

type ChordRow = {
  /** What the row proves, in the writer's terms. */
  claim: string;
  lanes: readonly Lane[];
  /** Transient surfaces open right now, shallowest first. */
  layers?: readonly ChromeLayer[];
  context?: ChromeContext;
  /** Where the keystroke came from. Prose unless the row says otherwise. */
  pressedFrom?: KeymapReach;
  handled: boolean;
  /** The lanes whose binding ran, in the order the ladder reached them. */
  ran: readonly string[];
};

const lane = (id: string, scope: KeymapScope, handles: boolean): Lane => ({ id, scope, handles });

const layerLane = (id: string, layer: ChromeLayer | null, handles: boolean): Lane => ({
  id,
  scope: "layer",
  layer,
  handles,
});

/** Press the chord once and report which lanes answered, in order. */
function pressChord(row: ChordRow): { handled: boolean; ran: string[] } {
  const ran: string[] = [];
  const contributions = row.lanes.map(({ id, scope, layer, reach, appliesTo, handles }) => {
    const binding = () => {
      ran.push(id);
      return handles;
    };
    return {
      id,
      scope,
      ...(scope === "layer" ? { layer: layer ?? null } : {}),
      ...(reach ? { reach } : {}),
      ...(appliesTo ? { appliesTo } : {}),
      bindings: { [CHORD]: binding },
    } as KeymapContribution;
  });
  const applicability = (): KeymapApplicability => ({
    context: row.context ?? ANYWHERE,
    layers: row.layers ?? [dialog],
  });
  const chord = mergeKeymapContributions(contributions, applicability, row.pressedFrom)[CHORD];

  return { handled: chord ? chord(state) : false, ran };
}

const CHORD_ROWS: readonly ChordRow[] = [
  {
    claim: "gives the chord to the deepest owner first (law 4)",
    lanes: [lane("table", "table", true), layerLane("slash", dialog, true)],
    handled: true,
    ran: ["slash"],
  },
  {
    claim: "hands the chord down when the deeper owner declines",
    lanes: [lane("blocks", "document", true), lane("object", "object", false)],
    handled: true,
    ran: ["object", "blocks"],
  },
  {
    claim: "reports the chord unhandled when nobody takes it",
    lanes: [lane("table", "table", false)],
    handled: false,
    ran: ["table"],
  },
  {
    // The dialog opens and registers, then the pane it opens inside itself
    // does. Arrival order says the dialog; depth says the pane. React makes the
    // reverse arrival just as ordinary — child effects run before parent ones —
    // so neither order may decide this.
    claim: "gives the chord to the deepest open layer, whichever registered first",
    lanes: [layerLane("diagram-dialog", dialog, true), layerLane("diagram-source", pane, true)],
    layers: [dialog, pane],
    handled: true,
    ran: ["diagram-source"],
  },
  {
    claim: "gives the chord to the deepest open layer when the deeper one registered first",
    lanes: [layerLane("diagram-source", pane, true), layerLane("diagram-dialog", dialog, true)],
    layers: [dialog, pane],
    handled: true,
    ran: ["diagram-source"],
  },
  {
    // A decline is about this chord, not about handing it to the surface
    // behind: the writer cannot reach the dialog while its own pane is open.
    claim: "drops the chord past every layer when the deepest one declines",
    lanes: [
      layerLane("diagram-dialog", dialog, true),
      layerLane("diagram-source", pane, false),
      lane("blocks", "block", true),
    ],
    layers: [dialog, pane],
    handled: true,
    ran: ["diagram-source", "blocks"],
  },
  {
    // The pane released and the dialog around it is still open, so layer scope
    // is live and the pane's keys are not.
    claim: "stops offering a layer's keys once that layer has closed",
    lanes: [layerLane("diagram-source", pane, true)],
    layers: [dialog],
    handled: false,
    ran: [],
  },
  {
    // The suggestion menus' case: the trigger registers the arrow keys a beat
    // before React opens the popover that becomes their layer.
    claim: "answers keys that name no layer when no open layer claims them",
    lanes: [layerLane("slash-menu", null, true)],
    layers: [dialog],
    handled: true,
    ran: ["slash-menu"],
  },
  {
    claim: "stands those keys down the moment an open layer claims the same chord",
    lanes: [layerLane("slash-menu", null, true), layerLane("diagram-dialog", dialog, true)],
    layers: [dialog],
    handled: true,
    ran: ["diagram-dialog"],
  },
  {
    // The slash menu's keys belong to a caret in the prose. Answering them from
    // wherever focus happens to be would take them from the chat composer.
    claim: "hands portalled focus only the contributions that reach that far",
    lanes: [
      layerLane("slash-menu", null, true),
      { ...layerLane("diagram-dialog", dialog, true), reach: "chrome" },
    ],
    pressedFrom: "chrome",
    handled: true,
    ran: ["diagram-dialog"],
  },
  {
    claim: "still runs a chrome-reach contribution from the prose",
    lanes: [{ ...layerLane("diagram-dialog", dialog, true), reach: "chrome" }],
    handled: true,
    ran: ["diagram-dialog"],
  },
  {
    claim: "drops a contribution the scope admitted but its own narrowing refuses",
    lanes: [
      {
        ...lane("object:code_block", "object", true),
        appliesTo: (context) => context.nodeType === "code_block",
      },
    ],
    context: objectContext,
    layers: [],
    handled: false,
    ran: [],
  },
];

describe("who answers a chord", () => {
  it.each(CHORD_ROWS)("$claim", (row) => {
    const pressed = pressChord(row);

    expect(pressed.ran).toEqual(row.ran);
    expect(pressed.handled).toBe(row.handled);
  });
});

type ScopeRow = {
  scope: KeymapScope;
  /** Where the writer is standing, named the way the row reads. */
  where: string;
  applicability: KeymapApplicability;
  applies: boolean;
};

const IN_PROSE: KeymapApplicability = { context: DOCUMENT_CHROME_CONTEXT, layers: [] };

const SCOPE_ROWS: readonly ScopeRow[] = [
  { scope: "layer", where: "in prose", applicability: IN_PROSE, applies: false },
  {
    scope: "layer",
    where: "with a transient surface open",
    applicability: { ...IN_PROSE, layers: [dialog] },
    applies: true,
  },
  { scope: "object", where: "in prose", applicability: IN_PROSE, applies: false },
  {
    scope: "object",
    where: "on a selected object",
    applicability: { context: objectContext, layers: [] },
    applies: true,
  },
  { scope: "table", where: "in prose", applicability: IN_PROSE, applies: false },
  {
    scope: "table",
    where: "inside a table cell",
    applicability: { context: cellContext, layers: [] },
    applies: true,
  },
  // Block and document are order rather than place: both are live everywhere,
  // and differ only in who wins when they collide.
  { scope: "block", where: "in prose", applicability: IN_PROSE, applies: true },
  { scope: "document", where: "in prose", applicability: IN_PROSE, applies: true },
];

describe("where a scope is live", () => {
  it.each(SCOPE_ROWS)("$scope scope $where: $applies", ({ scope, applicability, applies }) => {
    expect(keymapScopeApplies(scope, applicability)).toBe(applies);
  });
});

type RegistrationRow = {
  /** What the row proves, in the writer's terms. */
  claim: string;
  contribution: KeymapContribution;
  registered?: readonly KeymapContribution[];
  /** The refusal the lane must read, or null where registration stands. */
  refuses: RegExp | null;
};

const contribution = (
  id: string,
  scope: Exclude<KeymapScope, "layer">,
  key = CHORD,
): KeymapContribution => ({ id, scope, bindings: { [key]: () => true } });

const layerContribution = (id: string, layer: ChromeLayer | null): KeymapContribution => ({
  id,
  scope: "layer",
  layer,
  bindings: { [CHORD]: () => true },
});

const REGISTRATION_ROWS: readonly RegistrationRow[] = [
  {
    claim: "refuses Escape: the walk-home chain owns it, not a surface",
    contribution: {
      ...layerContribution("diagram-dialog", dialog),
      bindings: { Escape: () => true },
    },
    refuses: /Esc chain owns it/,
  },
  {
    claim: "names the lane, so the refusal reaches whoever wrote the binding",
    contribution: { ...layerContribution("slash-menu", null), bindings: { Escape: () => true } },
    refuses: /"slash-menu"/,
  },
  {
    claim: "refuses chrome reach outside layer scope: a layer's keys end when it does",
    contribution: { ...contribution("object:code_block", "object", "Mod-Enter"), reach: "chrome" },
    refuses: /only a layer's keys/,
  },
  {
    claim: "passes an ordinary scoped contribution through",
    contribution: contribution("table", "table"),
    refuses: null,
  },
  {
    claim: "refuses a key another lane already owns in the same place",
    contribution: contribution("rival-lane", "document"),
    registered: [contribution("tab-indent", "document")],
    refuses: /where "tab-indent" already has it/,
  },
  {
    // A narrowed pair is the deliberate chain the merge runs, where declining
    // hands the key down — in either arrival order.
    claim: "leaves an unnarrowed lane alone where the registered one narrows",
    contribution: contribution("tab-indent", "block", "Tab"),
    registered: [{ ...contribution("tab-fence", "block", "Tab"), appliesTo: () => true }],
    refuses: null,
  },
  {
    claim: "leaves a narrowing lane alone where the registered one does not",
    contribution: { ...contribution("tab-list", "block", "Tab"), appliesTo: () => true },
    registered: [contribution("tab-indent", "block", "Tab")],
    refuses: null,
  },
  {
    claim: "leaves two lanes at different scopes alone: the ladder orders them",
    contribution: contribution("tab-indent", "document"),
    registered: [contribution("tab-table", "table")],
    refuses: null,
  },
  {
    claim: "leaves two named layers alone: depth orders them",
    contribution: layerContribution("diagram-source", pane),
    registered: [layerContribution("diagram-dialog", dialog)],
    refuses: null,
  },
  {
    // A contribution with no token has no place to collide in, which is what
    // lets both suggestion lanes spell ArrowDown.
    claim: "leaves two lanes that named no layer alone",
    contribution: layerContribution("wikilink-menu", null),
    registered: [layerContribution("slash-menu", null)],
    refuses: null,
  },
  {
    claim: "still refuses one layer claiming its own key twice",
    contribution: layerContribution("diagram-dialog", dialog),
    registered: [layerContribution("diagram-dialog", dialog)],
    refuses: new RegExp(CHORD),
  },
];

describe("what registration refuses", () => {
  it.each(REGISTRATION_ROWS)("$claim", (row) => {
    const register = () => assertKeymapContribution(row.contribution, row.registered ?? []);

    if (row.refuses) expect(register).toThrow(row.refuses);
    else expect(register).not.toThrow();
  });
});

describe("the merged keymap", () => {
  it("reads applicability per keystroke, because the writer's context moves", () => {
    // The merge is cached across keystrokes; where the caret stands is not.
    const run = vi.fn(() => true);
    const layers: ChromeLayer[] = [];
    const chord = mergeKeymapContributions(
      [{ id: "slash", scope: "layer", layer: dialog, bindings: { [CHORD]: run } }],
      () => ({ context: DOCUMENT_CHROME_CONTEXT, layers }),
    )[CHORD];

    expect(chord?.(state)).toBe(false);
    expect(run).not.toHaveBeenCalled();

    layers.push(dialog);

    expect(chord?.(state)).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });
});
