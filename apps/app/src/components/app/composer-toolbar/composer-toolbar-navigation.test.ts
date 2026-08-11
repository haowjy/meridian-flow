import { describe, expect, it } from "vitest";
import {
  deriveToolbarView,
  initialNavigationState,
  type NavigationEvent,
  type NavigationState,
  reduceNavigation,
  visibleContentCount,
} from "./composer-toolbar-navigation";
import type { ComposerToolbarControlInput, ToolbarNavigationInput } from "./types";

const panel = (
  id: string,
  options: { interaction?: "enabled" | "busy"; page?: string; repair?: string } = {},
): Extract<ComposerToolbarControlInput, { kind: "panel" }> => ({
  id,
  kind: "panel",
  interaction: options.interaction ?? "enabled",
  page: {
    id: options.page ?? "ready",
    repairRevision: options.repair ?? "a",
    candidateKeys: ["row"],
  },
});
const status = (id: string): ComposerToolbarControlInput => ({ id, kind: "status" });
const input = (...controls: ComposerToolbarControlInput[]): ToolbarNavigationInput => ({
  controls,
  revision: JSON.stringify(controls),
});
const baseInput = input(panel("agent"), panel("write"), panel("work"), status("status"));
const layout = (inlineIds: readonly string[], source = baseInput) => ({
  inlineIds,
  overflowIds: source.controls.map(({ id }) => id).filter((id) => !inlineIds.includes(id)),
  constrained: inlineIds.length !== source.controls.length,
});
const send = (state: NavigationState, event: NavigationEvent) => reduceNavigation(state, event);
const measured = (inlineIds: readonly string[] = [], source = baseInput) =>
  send(initialNavigationState(source), {
    type: "layout.measured",
    layout: layout(inlineIds, source),
  });
const open = (id = "agent", inlineIds: readonly string[] = [], source = baseInput) =>
  send(measured(inlineIds, source), { type: "panel.triggered", controlId: id });

describe("composer toolbar navigation inputs", () => {
  it("atomically invalidates panel to status and removal, including a locked surface", () => {
    for (const replacement of [input(status("agent")), input(panel("other"))]) {
      let state = open();
      state = send(state, {
        type: "panel.blockingStarted",
        panel: state.surface.kind === "panel" ? state.surface.panel : { controlId: "", session: 0 },
      });
      const next = send(state, { type: "inputs.changed", input: replacement });
      expect(next.surface.kind).toBe("closed");
      expect(next.focus?.target).toEqual({ kind: "control.owner", controlId: "agent" });
    }
  });

  it("keeps status to panel closed and normalizes removed/new layout IDs", () => {
    const before = measured([], input(status("agent"), panel("old")));
    const replacement = input(panel("agent"), panel("new"));
    const next = send(before, { type: "inputs.changed", input: replacement });
    expect(next.surface.kind).toBe("closed");
    expect(next.layout).toMatchObject({ inlineIds: [], overflowIds: ["agent", "new"] });
  });

  it("distinguishes page entry from same-page conditional repair", () => {
    const state = open("agent", [], input(panel("agent", { page: "loading", repair: "0" })));
    const entered = send(state, {
      type: "inputs.changed",
      input: input(panel("agent", { page: "ready", repair: "rows" })),
    });
    expect(entered.focus?.target.kind).toBe("panel.enter");
    const repaired = send(entered, {
      type: "inputs.changed",
      input: input(panel("agent", { page: "ready", repair: "other-rows" })),
    });
    expect(repaired.focus?.target.kind).toBe("panel.repair");

    const candidateChanged = send(repaired, {
      type: "inputs.changed",
      input: {
        revision: "candidate-change",
        controls: [
          {
            ...panel("agent", { page: "ready", repair: "other-rows" }),
            page: { id: "ready", repairRevision: "other-rows", candidateKeys: ["other-row"] },
          },
        ],
      },
    });
    expect(candidateChanged.focus?.target.kind).toBe("panel.repair");
  });

  it("is identity-preserving for structurally equivalent fresh input", () => {
    const state = open();
    const equivalent = input(panel("agent"), panel("write"), panel("work"), status("status"));
    expect(send(state, { type: "inputs.changed", input: equivalent })).toBe(state);
  });

  it("ignores stale outcomes after structural invalidation", () => {
    const state = open();
    if (state.surface.kind !== "panel") throw new Error("expected panel");
    const session = state.surface.panel;
    const invalidated = send(state, { type: "inputs.changed", input: input(status("agent")) });
    expect(
      send(invalidated, { type: "panel.blockingSettled", panel: session, outcome: "close" }),
    ).toBe(invalidated);
  });
});

describe("composer toolbar navigation policy", () => {
  it("opens root and panels and maintains zero-or-one content", () => {
    const root = send(measured(), { type: "root.triggered" });
    expect(root.surface).toEqual({ kind: "root", cursorId: "agent" });
    const opened = send(root, { type: "panel.triggered", controlId: "agent" });
    expect(opened.focus?.target.kind).toBe("panel.enter");
    for (const state of [measured(), root, opened])
      expect(visibleContentCount(deriveToolbarView(state))).toBe(
        state.surface.kind === "closed" ? 0 : 1,
      );
  });

  it("refuses busy panels and all competing navigation while locked", () => {
    const busyInput = input(panel("busy", { interaction: "busy" }));
    const busy = measured([], busyInput);
    expect(send(busy, { type: "panel.triggered", controlId: "busy" })).toBe(busy);
    let locked = open();
    if (locked.surface.kind !== "panel") throw new Error("expected panel");
    const session = locked.surface.panel;
    locked = send(locked, { type: "panel.blockingStarted", panel: session });
    for (const event of [
      { type: "panel.triggered", controlId: "work" },
      { type: "root.triggered" },
      { type: "panel.dismissRequested", panel: session, cause: "escape" },
      { type: "panel.backRequested", panel: session },
    ] satisfies NavigationEvent[])
      expect(send(locked, event)).toBe(locked);
  });

  it("does not issue focus on host-only layout migration", () => {
    const state = open("agent", ["agent"]);
    const acknowledged = state.focus
      ? send(state, { type: "focus.executed", token: state.focus.token })
      : state;
    const migrated = send(acknowledged, { type: "layout.measured", layout: layout([]) });
    expect(migrated.surface).toBe(acknowledged.surface);
    expect(migrated.focus).toBeNull();
  });

  it("retains topology while locked and reconciles once to the latest measurement", () => {
    for (const [initialInline, firstInline, finalInline] of [
      [["agent"], [], ["agent"]],
      [[], ["agent"], []],
    ] as const) {
      let state = open("agent", initialInline);
      if (state.surface.kind !== "panel") throw new Error("expected panel");
      const session = state.surface.panel;
      state = send(state, { type: "panel.blockingStarted", panel: session });

      const first = send(state, { type: "layout.measured", layout: layout(firstInline) });
      expect(first.layout).toBe(state.layout);
      expect(deriveToolbarView(first)).toEqual(deriveToolbarView(state));
      const latest = send(first, { type: "layout.measured", layout: layout(finalInline) });
      expect(latest.layout).toBe(state.layout);
      expect(latest.deferredLayout).toEqual(layout(finalInline));

      const settled = send(latest, {
        type: "panel.blockingSettled",
        panel: session,
        outcome: "stay",
      });
      expect(settled.layout).toEqual(layout(finalInline));
      expect(settled.deferredLayout).toBeNull();
      expect(settled.surface).toMatchObject({ kind: "panel", lock: "dismissible" });
    }
  });

  it("returns Back to its row and close to the semantic owner", () => {
    const state = open();
    if (state.surface.kind !== "panel") throw new Error("expected panel");
    const back = send(state, { type: "panel.backRequested", panel: state.surface.panel });
    expect(back.focus?.target).toEqual({ kind: "root.row", controlId: "agent" });
    const closed = send(state, { type: "panel.terminalClose", panel: state.surface.panel });
    expect(closed.focus?.target).toEqual({ kind: "control.owner", controlId: "agent" });
  });
});
