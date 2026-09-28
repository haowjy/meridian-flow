/** The barrier's order is independent of persistence and Work rendering. */
import { describe, expect, it } from "vitest";
import { planControlBarrier } from "./control-barrier.js";
import type { InboxMessage } from "./ports.js";

const row = (id: string, intent: InboxMessage["intent"] = "message"): InboxMessage => ({
  id,
  seq: 0,
  threadId: "thread",
  intent,
  provenance: { kind: "system", source: "test" },
  body: intent === "control" ? { kind: "compact" } : { kind: "text", text: id },
  idempotencyKey: id,
  enqueuedAt: "now",
  deliveredAt: null,
});
const control = row("K", "control");
function plan(pending: InboxMessage[], chained: string[] = [], bound: string[] = []) {
  const result = planControlBarrier({
    pending,
    chainedIds: new Set(chained),
    boundIds: new Set(bound),
  });
  return { batch: result.batch.map((row) => row.id), execute: result.execute?.id ?? null };
}
describe("control barrier", () => {
  it("adopts all non-controls without a head", () =>
    expect(plan([row("M"), row("N", "notice")])).toEqual({ batch: ["M", "N"], execute: null }));
  it("lets directed rows ahead answer first", () =>
    expect(plan([row("M"), control, row("after")])).toEqual({ batch: ["M"], execute: null }));
  it("adopts every chained row when a chained message is behind K", () =>
    expect(plan([row("M1"), control, row("M2"), row("agent")], ["M1", "M2"])).toEqual({
      batch: ["M1", "M2"],
      execute: "K",
    }));
  it("notices never hold the head back", () =>
    expect(plan([row("N", "notice"), control, row("agent")])).toEqual({
      batch: ["N"],
      execute: "K",
    }));
  it("carries no bound rows into another adoption", () =>
    expect(plan([control, row("K2", "control"), row("M")], ["M"], ["K", "M"])).toEqual({
      batch: [],
      execute: "K2",
    }));
  it("excludes a Work refresh behind the head before coalescing", () => {
    const before = { ...row("W1", "notice"), body: { kind: "work_context_refresh" as const } };
    const after = { ...before, id: "W2" };
    expect(plan([before, control, after])).toEqual({ batch: ["W1"], execute: "K" });
  });
});
