import { describe, expect, it } from "vitest";
import {
  deriveToolbarView,
  initialNavigationState,
  type NavigationEvent,
  type NavigationState,
  type PanelSession,
  reduceNavigation,
  visibleContentCount,
} from "./composer-toolbar-navigation";
import type { ComposerToolbarControl } from "./types";

const ref = { current: null };
const panelControl = (id: string, priority = 1): ComposerToolbarControl => ({
  id,
  priority,
  inline: () => null,
  overflow: {
    kind: "panel",
    item: { ariaLabel: id, label: id },
    panel: { ariaLabel: id, size: "compact", initialFocusRef: ref, render: () => null },
  },
});
const statusControl = (id: string): ComposerToolbarControl => ({
  id,
  priority: 0,
  inline: () => null,
  overflow: { kind: "status", item: { ariaLabel: id, label: id } },
});
const controls = [panelControl("a", 3), panelControl("b", 2), panelControl("c", 1)];
const mixedControls = [...controls, statusControl("status")];
const layout = (inlineIds: string[], source = controls) => ({
  inlineIds,
  overflowIds: source.map((c) => c.id).filter((id) => !inlineIds.includes(id)),
  constrained: true,
});
const send = <T extends readonly ComposerToolbarControl[]>(
  state: NavigationState,
  event: NavigationEvent,
  source: T = controls as unknown as T,
) => reduceNavigation(state, event, source);
const measured = (inlineIds: string[], source = controls) =>
  send(
    initialNavigationState(source),
    {
      type: "layout.measured",
      layout: layout(inlineIds, source),
    },
    source,
  );
const open = (id = "a", inlineIds: string[] = [], blocking = false) =>
  send(measured(inlineIds), {
    type: blocking ? "panel.blockingTriggered" : "panel.triggered",
    controlId: id,
  });
const sessionOf = (state: NavigationState): PanelSession => {
  if (state.surface.kind !== "panel") throw new Error("expected panel");
  return state.surface.panel;
};
const expectSurfaceInvariant = (state: NavigationState) => {
  const count = visibleContentCount(deriveToolbarView(state));
  expect(count).toBe(state.surface.kind === "closed" ? 0 : 1);
};

describe("composer toolbar navigation transition matrix", () => {
  it.each(["escape", "outside"] as const)("opens root and closes it on %s", (cause) => {
    const root = send(initialNavigationState(controls), { type: "root.triggered" });
    expect(root.surface).toEqual({ kind: "root", cursorId: "a" });
    expect(root.focus?.target).toEqual({ kind: "root.row", controlId: "a" });
    const closed = send(root, { type: "root.dismissRequested", cause });
    expect(closed.surface.kind).toBe("closed");
    expect(closed.focus?.target).toEqual({ kind: "overflow.trigger" });
  });

  it("toggles the root and ignores a root trigger when nothing overflows", () => {
    const root = send(initialNavigationState(controls), { type: "root.triggered" });
    expect(send(root, { type: "root.triggered" }).surface.kind).toBe("closed");
    const allInline = measured(["a", "b", "c"]);
    expect(send(allInline, { type: "root.triggered" })).toBe(allInline);
  });

  it("opens a status-only overflow root with a null cursor", () => {
    const source = [statusControl("readonly")];
    const root = send(initialNavigationState(source), { type: "root.triggered" }, source);
    expect(root.surface).toEqual({ kind: "root", cursorId: null });
    expect(root.focus?.target).toEqual({ kind: "root.content" });
  });

  it.each([
    ["direct", ["a"]],
    ["overflow", []],
  ] as const)("opens a %s panel without visiting root", (_name, inlineIds) => {
    const state = open("a", [...inlineIds]);
    expect(state.surface).toMatchObject({
      kind: "panel",
      panel: { controlId: "a", session: 1 },
      lock: "dismissible",
    });
    expect(state.focus?.target).toEqual({
      kind: "panel.initial",
      panel: { controlId: "a", session: 1 },
    });
  });

  it("toggles the same dismissible trigger and refuses it while locked", () => {
    const dismissible = open("a", ["a"]);
    const closed = send(dismissible, { type: "panel.triggered", controlId: "a" });
    expect(closed.surface.kind).toBe("closed");
    expect(closed.focus?.target).toEqual({ kind: "control.visibleTrigger", controlId: "a" });
    const locked = open("a", ["a"], true);
    expect(send(locked, { type: "panel.triggered", controlId: "a" })).toBe(locked);
  });

  it("switches A to B atomically with a new session", () => {
    const a = open("a", ["a", "b"]);
    const b = send(a, { type: "panel.triggered", controlId: "b" });
    expect(b.surface).toMatchObject({
      kind: "panel",
      panel: { controlId: "b", session: 2 },
      lock: "dismissible",
    });
    expectSurfaceInvariant(b);
  });

  it("blocking trigger opens or switches atomically and locked", () => {
    for (const start of [measured([]), open("a")]) {
      const state = send(start, { type: "panel.blockingTriggered", controlId: "b" });
      expect(state.surface).toMatchObject({
        kind: "panel",
        panel: { controlId: "b" },
        lock: "nondismissible",
      });
    }
  });

  it("identity-refuses every competing navigation event while locked", () => {
    const locked = open("a", [], true);
    const panel = sessionOf(locked);
    const events: NavigationEvent[] = [
      { type: "panel.triggered", controlId: "a" },
      { type: "panel.triggered", controlId: "b" },
      { type: "panel.blockingTriggered", controlId: "b" },
      { type: "panel.dismissRequested", panel, cause: "escape" },
      { type: "panel.dismissRequested", panel, cause: "outside" },
      { type: "panel.dismissRequested", panel, cause: "programmatic" },
      { type: "panel.backRequested", panel },
      { type: "root.triggered" },
    ];
    for (const event of events) expect(send(locked, event), event.type).toBe(locked);
  });

  it.each([
    "escape",
    "outside",
    "programmatic",
  ] as const)("accepts dismissible panel %s dismissal", (cause) => {
    const state = open("a");
    const closed = send(state, {
      type: "panel.dismissRequested",
      panel: sessionOf(state),
      cause,
    });
    expect(closed.surface.kind).toBe("closed");
  });

  it("Back returns overflow to the exact row and is ignored inline", () => {
    const overflow = open("a", []);
    const back = send(overflow, { type: "panel.backRequested", panel: sessionOf(overflow) });
    expect(back.surface).toEqual({ kind: "root", cursorId: "a" });
    expect(back.focus?.target).toEqual({ kind: "root.row", controlId: "a" });
    const direct = open("a", ["a"]);
    expect(send(direct, { type: "panel.backRequested", panel: sessionOf(direct) })).toBe(direct);
  });

  it("settles blocking operations close or stay and terminal-close succeeds while locked", () => {
    const dismissible = open("a");
    const started = send(dismissible, {
      type: "panel.blockingStarted",
      panel: sessionOf(dismissible),
    });
    expect(started.surface).toMatchObject({ kind: "panel", lock: "nondismissible" });
    expect(started.focus).toBe(dismissible.focus);

    const locked = open("a", [], true);
    const panel = sessionOf(locked);
    const stay = send(locked, { type: "panel.blockingSettled", panel, outcome: "stay" });
    expect(stay.surface).toMatchObject({ kind: "panel", lock: "dismissible" });
    expect(stay.focus).toBe(locked.focus);
    expect(
      send(locked, { type: "panel.blockingSettled", panel, outcome: "close" }).surface.kind,
    ).toBe("closed");
    expect(send(locked, { type: "panel.terminalClose", panel }).surface.kind).toBe("closed");
  });

  it("ignores every stale session event", () => {
    const state = open("a");
    const stale = { ...sessionOf(state), session: 0 };
    const events: NavigationEvent[] = [
      { type: "panel.dismissRequested", panel: stale, cause: "escape" },
      { type: "panel.backRequested", panel: stale },
      { type: "panel.blockingStarted", panel: stale },
      { type: "panel.blockingSettled", panel: stale, outcome: "stay" },
      { type: "panel.blockingSettled", panel: stale, outcome: "close" },
      { type: "panel.terminalClose", panel: stale },
    ];
    for (const event of events) expect(send(state, event), event.type).toBe(state);
  });
});

describe("composer toolbar navigation layout and focus", () => {
  it("updates a host-unchanged measurement without changing session, lock, or focus", () => {
    const state = open("a", ["a", "b"], true);
    const nextLayout = layout(["a"]);
    const next = send(state, { type: "layout.measured", layout: nextLayout });
    expect(next.surface).toBe(state.surface);
    expect(next.focus).toBe(state.focus);
    expect(next.layout).toBe(nextLayout);
  });

  it.each([
    ["direct to overflow", ["a"], []],
    ["overflow to direct", [], ["a"]],
  ] as const)("migrates %s preserving session and lock", (_name, before, after) => {
    const state = open("a", [...before], true);
    const surface = state.surface;
    const next = send(state, { type: "layout.measured", layout: layout([...after]) });
    expect(next.surface).toBe(surface);
    expect(next.focus?.target).toEqual({ kind: "panel.initial", panel: sessionOf(state) });
  });

  it("closes when the cursor promotes, with overflow remaining or none", () => {
    let root = send(measured([]), { type: "root.triggered" });
    root = send(root, { type: "root.rowFocused", controlId: "b" });
    for (const nextLayout of [layout(["b"]), layout(["a", "b", "c"])]) {
      const next = send(root, { type: "layout.measured", layout: nextLayout });
      expect(next.surface.kind).toBe("closed");
      expect(next.focus?.target).toEqual({ kind: "control.visibleTrigger", controlId: "b" });
    }
  });

  it("uses the first promoted fallback when a cursorless root loses overflow", () => {
    const source = [statusControl("status"), panelControl("a")];
    let root = send(initialNavigationState(source), { type: "root.triggered" }, source);
    root = { ...root, surface: { kind: "root", cursorId: null } };
    const next = send(
      root,
      { type: "layout.measured", layout: layout(["status", "a"], source) },
      source,
    );
    expect(next.surface.kind).toBe("closed");
    expect(next.focus?.target).toEqual({
      kind: "control.visibleTrigger",
      controlId: "status",
    });
  });

  it("keeps root open when a noncursor row promotes", () => {
    let root = send(measured([]), { type: "root.triggered" });
    root = send(root, { type: "root.rowFocused", controlId: "a" });
    const next = send(root, { type: "layout.measured", layout: layout(["c"]) });
    expect(next.surface).toEqual({ kind: "root", cursorId: "a" });
    expect(next.focus).toBe(root.focus);
  });

  it("falls back to the nearest interactive row or root content when the cursor disappears", () => {
    let root = send(
      initialNavigationState(mixedControls),
      { type: "root.triggered" },
      mixedControls,
    );
    root = send(root, { type: "root.rowFocused", controlId: "b" }, mixedControls);
    const replacement = send(
      root,
      { type: "layout.measured", layout: layout(["b"], mixedControls) },
      mixedControls,
    );
    // Promotion is stronger than replacement: the focused row became an inline trigger.
    expect(replacement.surface.kind).toBe("closed");

    const cursorRemoved = {
      ...root,
      surface: { kind: "root" as const, cursorId: "missing" },
    };
    const onlyStatus = send(
      cursorRemoved,
      {
        type: "layout.measured",
        layout: { inlineIds: ["a", "b", "c"], overflowIds: ["status"], constrained: true },
      },
      mixedControls,
    );
    expect(onlyStatus.surface).toEqual({ kind: "root", cursorId: null });
    expect(onlyStatus.focus?.target).toEqual({ kind: "root.content" });
  });

  it("closes an invalid active panel to overflow or inline fallback", () => {
    const state = open("a");
    const withoutA = [controls[1], controls[2], statusControl("status")];
    const overflowFallback = send(
      state,
      {
        type: "layout.measured",
        layout: { inlineIds: ["b", "c"], overflowIds: ["status"], constrained: true },
      },
      withoutA,
    );
    expect(overflowFallback.focus?.target).toEqual({ kind: "overflow.trigger" });
    const inlineFallback = send(
      state,
      {
        type: "layout.measured",
        layout: { inlineIds: ["b", "c", "status"], overflowIds: [], constrained: false },
      },
      withoutA,
    );
    expect(inlineFallback.focus?.target).toEqual({
      kind: "control.visibleTrigger",
      controlId: "b",
    });
  });

  it("acknowledges only the current focus token", () => {
    const first = send(initialNavigationState(controls), { type: "root.triggered" });
    const oldToken = first.focus?.token;
    if (oldToken === undefined) throw new Error("missing focus intent");
    const newer = send(first, { type: "root.triggered" });
    expect(send(newer, { type: "focus.executed", token: oldToken })).toBe(newer);
    const currentToken = newer.focus?.token;
    if (currentToken === undefined) throw new Error("missing current focus intent");
    expect(send(newer, { type: "focus.executed", token: currentToken }).focus).toBeNull();
  });

  it("maintains zero/one derived content across representative states and events", () => {
    const closed = measured(["a"]);
    const root = send(measured([]), { type: "root.triggered" });
    const dismissible = open("a");
    const locked = open("a", [], true);
    for (const state of [closed, root, dismissible, locked]) {
      const panel =
        state.surface.kind === "panel" ? state.surface.panel : { controlId: "a", session: 0 };
      const events: NavigationEvent[] = [
        { type: "layout.measured", layout: layout([]) },
        { type: "root.triggered" },
        { type: "root.dismissRequested", cause: "escape" },
        { type: "root.dismissRequested", cause: "outside" },
        { type: "root.rowFocused", controlId: "b" },
        { type: "panel.triggered", controlId: "a" },
        { type: "panel.triggered", controlId: "b" },
        { type: "panel.blockingTriggered", controlId: "b" },
        { type: "panel.dismissRequested", panel, cause: "programmatic" },
        { type: "panel.backRequested", panel },
        { type: "panel.blockingStarted", panel },
        { type: "panel.blockingSettled", panel, outcome: "stay" },
        { type: "panel.blockingSettled", panel, outcome: "close" },
        { type: "panel.terminalClose", panel },
        { type: "focus.executed", token: state.focus?.token ?? 0 },
      ];
      expectSurfaceInvariant(state);
      for (const event of events) expectSurfaceInvariant(send(state, event));
    }
  });
});
