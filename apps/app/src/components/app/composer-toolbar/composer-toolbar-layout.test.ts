import { describe, expect, it } from "vitest";
import { resolveComposerToolbarLayout } from "./composer-toolbar-layout";

const controls = [
  { id: "agent", priority: 300, overflow: { ariaLabel: "Agent", label: "Agent" } },
  { id: "write-mode", priority: 200, overflow: { ariaLabel: "Write mode", label: "Write mode" } },
  { id: "work", priority: 100, overflow: { ariaLabel: "Work", label: "Work" } },
];
const widths = new Map([
  ["agent", 80],
  ["write-mode", 120],
  ["work", 100],
]);
const resolve = (available: number) =>
  resolveComposerToolbarLayout(controls, {
    available,
    gap: 8,
    overflowTrigger: 32,
    controlWidths: widths,
  });

describe("resolveComposerToolbarLayout", () => {
  it("keeps exact and subpixel-rounding fits inline", () => {
    expect(resolve(316).overflowIds).toEqual([]);
    expect(resolve(315.6).overflowIds).toEqual([]);
    expect(resolve(315.4).overflowIds).toEqual(["work"]);
  });
  it("collapses Work, write mode, then Agent while preserving source order", () => {
    expect(resolve(250).overflowIds).toEqual(["work"]);
    expect(resolve(125).overflowIds).toEqual(["write-mode", "work"]);
    expect(resolve(31).overflowIds).toEqual(["agent", "write-mode", "work"]);
    expect(resolve(31).constrained).toBe(true);
  });
  it("evicts later equal-priority controls first", () => {
    const peers = controls.map((control) => ({ ...control, priority: 1 }));
    expect(
      resolveComposerToolbarLayout(peers, {
        available: 250,
        gap: 8,
        overflowTrigger: 32,
        controlWidths: widths,
      }).overflowIds,
    ).toEqual(["work"]);
  });
  it("rejects duplicate stable IDs", () => {
    expect(() =>
      resolveComposerToolbarLayout([controls[0], controls[0]], {
        available: 1,
        gap: 0,
        overflowTrigger: 1,
        controlWidths: widths,
      }),
    ).toThrow(/unique/);
  });
});
