import type { Turn } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { buildTranscriptModel } from "./transcript-model";

const assistant = (id: string, status = "complete", completedAt = "2026-01-01T00:01:00Z") =>
  ({ id, role: "assistant", status, completedAt }) as unknown as Turn;
const writer = (id: string, createdAt: string, delivery?: "steer") =>
  ({ id, role: "user", createdAt, metadata: delivery ? { delivery } : null }) as unknown as Turn;
const ids = (turns: readonly Turn[]) => turns.map((turn) => turn.id);

describe("buildTranscriptModel response grouping", () => {
  it("joins visible assistant turns across a hidden notification gap", () => {
    const visibleTurns = [assistant("first"), assistant("last")];
    const grouped = buildTranscriptModel(visibleTurns, false);
    expect(ids(grouped.partsByFinalTurnId.get("last") ?? [])).toEqual(["first", "last"]);
    expect(grouped.continuing).toEqual([true, false]);
  });

  it("joins assistant parts across a writer steer without including the writer turn", () => {
    const turns = [
      assistant("first", "complete", "2026-01-01T00:01:00Z"),
      writer("steer", "2026-01-01T00:00:30Z", "steer"),
      assistant("last", "complete", "2026-01-01T00:02:00Z"),
    ];
    const grouped = buildTranscriptModel(turns, false);
    expect(ids(grouped.partsByFinalTurnId.get("last") ?? [])).toEqual(["first", "last"]);
    expect(grouped.continuing).toEqual([true, false, false]);
  });

  it("keeps a writer reply after completion in a separate response", () => {
    const turns = [
      assistant("first", "complete", "2026-01-01T00:01:00Z"),
      writer("reply", "2026-01-01T00:00:30Z"),
      assistant("second", "complete", "2026-01-01T00:02:00Z"),
    ];
    const grouped = buildTranscriptModel(turns, false);
    expect(ids(grouped.partsByFinalTurnId.get("first") ?? [])).toEqual(["first"]);
    expect(ids(grouped.partsByFinalTurnId.get("second") ?? [])).toEqual(["second"]);
  });

  it("ends a reply at a cancelled part", () => {
    const turns = [assistant("first"), assistant("cancelled", "cancelled"), assistant("later")];
    const grouped = buildTranscriptModel(turns, false);
    expect(ids(grouped.partsByFinalTurnId.get("cancelled") ?? [])).toEqual(["first", "cancelled"]);
    expect(ids(grouped.partsByFinalTurnId.get("later") ?? [])).toEqual(["later"]);
    expect(grouped.continuing).toEqual([true, false, false]);
  });
});
