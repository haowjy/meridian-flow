import { describe, expect, it } from "vitest";
import {
  applyTrailShellTransition,
  type ChangeTrailShell,
  emptyTrailShellState,
  reconcileTrailShells,
  upsertTrailShell,
} from "./change-trails";

const shell = (
  version: number,
  state: ChangeTrailShell["state"] = "building",
): ChangeTrailShell => ({
  trailId: "trail-1",
  owner: { kind: "turn", threadId: "thread-1", turnId: "turn-1" },
  state,
  version,
  changeCount: version,
  sweptChangeCount: 0,
  documentCount: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
  settledAt: state === "settled" ? "2026-01-01T00:00:01.000Z" : null,
});

describe("change trail shell state", () => {
  it("applies a live updated to settled transition", () => {
    const updated = applyTrailShellTransition(emptyTrailShellState(), {
      kind: "updated",
      threadId: "thread-1",
      trailId: "trail-1",
      turnId: "turn-1",
      version: 2,
      counts: { changes: 1, swept: 0, documents: 1 },
    });
    const settled = applyTrailShellTransition(updated, {
      kind: "settled",
      threadId: "thread-1",
      trailId: "trail-1",
      turnId: "turn-1",
      version: 3,
    });
    expect(settled.byId["trail-1"].state).toBe("settled");
  });

  it("returns a reopened settled trail to building", () => {
    const settled = upsertTrailShell(emptyTrailShellState(), shell(3, "settled"));
    const reopened = applyTrailShellTransition(settled, {
      kind: "updated",
      threadId: "thread-1",
      trailId: "trail-1",
      turnId: "turn-1",
      version: 4,
      counts: { changes: 4, swept: 1, documents: 1 },
    });
    expect(reopened.byId["trail-1"]).toMatchObject({ state: "building", version: 4 });
  });

  it("drops a true duplicate transition", () => {
    const once = upsertTrailShell(emptyTrailShellState(), shell(3, "settled"));
    expect(
      applyTrailShellTransition(once, {
        kind: "settled",
        threadId: "thread-1",
        trailId: "trail-1",
        turnId: "turn-1",
        version: 3,
      }),
    ).toBe(once);
  });

  it("ignores replayed and older versions instead of double-counting", () => {
    const once = upsertTrailShell(emptyTrailShellState(), shell(2));
    expect(upsertTrailShell(once, shell(2))).toBe(once);
    expect(upsertTrailShell(once, shell(1))).toBe(once);
    expect(once.byId["trail-1"].changeCount).toBe(2);
  });

  it("clears a pending gap only after endpoint reconciliation", () => {
    const gapped = { ...upsertTrailShell(emptyTrailShellState(), shell(1)), gapPending: true };
    const reconciled = reconcileTrailShells(gapped, [shell(3, "settled")]);
    expect(reconciled.gapPending).toBe(false);
    expect(reconciled.byId["trail-1"]).toMatchObject({ version: 3, state: "settled" });
  });

  it("replaces shells authoritatively so deleted detail owners cannot survive a gap", () => {
    const prior = upsertTrailShell(emptyTrailShellState(), shell(1));
    expect(reconcileTrailShells({ ...prior, gapPending: true }, [])).toEqual({
      byId: {},
      gapPending: false,
    });
  });
});
