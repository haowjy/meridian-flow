import { describe, expect, it } from "vitest";
import {
  deriveToolbarView,
  initialNavigationState,
  reduceNavigation,
  visibleContentCount,
} from "./composer-toolbar-navigation";
import type { ComposerToolbarControl } from "./types";

const ref = { current: null };
const controls = ["a", "b", "c"].map(
  (id, priority): ComposerToolbarControl => ({
    id,
    priority,
    inline: () => null,
    overflow: {
      kind: "panel",
      item: { ariaLabel: id, label: id },
      panel: { ariaLabel: id, size: "compact", initialFocusRef: ref, render: () => null },
    },
  }),
);
const layout = (inlineIds: string[]) => ({
  inlineIds,
  overflowIds: controls.map((c) => c.id).filter((id) => !inlineIds.includes(id)),
  constrained: true,
});
const send = (
  s: ReturnType<typeof initialNavigationState>,
  event: Parameters<typeof reduceNavigation>[1],
) => reduceNavigation(s, event, controls);
describe("composer toolbar navigation", () => {
  it("opens and toggles root", () => {
    let s = send(initialNavigationState(controls), { type: "root.triggered" });
    expect(s.surface.kind).toBe("root");
    s = send(s, { type: "root.triggered" });
    expect(s.surface.kind).toBe("closed");
  });
  it("opens direct and overflow panels with exactly one content", () => {
    for (const l of [layout(["a"]), layout([])]) {
      let s = send(initialNavigationState(controls), { type: "layout.measured", layout: l });
      s = send(s, { type: "panel.triggered", controlId: "a" });
      expect(visibleContentCount(deriveToolbarView(s))).toBe(1);
    }
  });
  it("switches A to B in one transition", () => {
    let s = send(initialNavigationState(controls), { type: "panel.triggered", controlId: "a" });
    s = send(s, { type: "panel.triggered", controlId: "b" });
    expect(s.surface).toMatchObject({ kind: "panel", panel: { controlId: "b" } });
  });
  it("refuses all ordinary navigation while locked", () => {
    const s = send(initialNavigationState(controls), {
      type: "panel.blockingTriggered",
      controlId: "a",
    });
    const before = s;
    if (s.surface.kind !== "panel") throw 0;
    const p = s.surface.panel;
    for (const event of [
      { type: "panel.triggered", controlId: "b" },
      { type: "panel.dismissRequested", panel: p, cause: "escape" },
      { type: "panel.backRequested", panel: p },
      { type: "root.triggered" },
    ] as const)
      expect(send(s, event)).toBe(before);
  });
  it("rejects stale completion and accepts matching terminal close", () => {
    const s = send(initialNavigationState(controls), {
      type: "panel.blockingTriggered",
      controlId: "a",
    });
    if (s.surface.kind !== "panel") throw 0;
    const p = s.surface.panel;
    expect(send(s, { type: "panel.terminalClose", panel: { ...p, session: p.session + 1 } })).toBe(
      s,
    );
    expect(send(s, { type: "panel.terminalClose", panel: p }).surface.kind).toBe("closed");
  });
  it("migrates atomically preserving session and lock", () => {
    let s = send(initialNavigationState(controls), {
      type: "layout.measured",
      layout: layout(["a"]),
    });
    s = send(s, { type: "panel.blockingTriggered", controlId: "a" });
    const before = s.surface;
    s = send(s, { type: "layout.measured", layout: layout([]) });
    expect(s.surface).toEqual(before);
    expect(s.focus?.target.kind).toBe("panel.initial");
  });
  it("promotes cursor deterministically with and without remaining overflow", () => {
    let s = send(initialNavigationState(controls), { type: "root.triggered" });
    s = send(s, { type: "root.rowFocused", controlId: "a" });
    for (const l of [layout(["a"]), layout(["a", "b", "c"])]) {
      const n = send(s, { type: "layout.measured", layout: l });
      expect(n.surface.kind).toBe("closed");
      expect(n.focus?.target).toEqual({ kind: "control.visibleTrigger", controlId: "a" });
    }
  });
  it("does not acknowledge a newer focus token", () => {
    let s = send(initialNavigationState(controls), { type: "root.triggered" });
    const token = s.focus?.token;
    if (token === undefined) throw new Error("missing focus intent");
    s = send(s, { type: "root.triggered" });
    expect(send(s, { type: "focus.executed", token })).toBe(s);
  });
});
