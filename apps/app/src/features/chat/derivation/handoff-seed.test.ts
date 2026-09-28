/** The brief card's view state, read from the seed S. */
import type { Turn } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { answeredControlIds } from "../compaction/compaction-model";
import {
  briefCardView,
  isOptimisticSeed,
  optimisticHandoffSeed,
  readHandoffBrief,
  readHandoffSeed,
} from "./handoff-seed";

const seed = (status: string, extra: Record<string, unknown> = {}) =>
  ({
    id: "s",
    role: "system",
    status,
    error: null,
    blocks: [],
    metadata: {
      kind: "derivation_seed",
      derivation: "handoff",
      sourceThreadId: "source",
      sourceRef: "c1",
      sourceTitle: "Chapter 12 plan",
      cutoffTurnId: "cut",
      controlMessageId: "k",
    },
    ...extra,
  }) as unknown as Turn;
const briefBlock = (state: "available" | "unavailable", brief: string | null) => ({
  id: "b",
  blockType: "custom",
  sequence: 0,
  content: { kind: "handoff-brief", props: { state, brief, modelText: "<system_update/>" } },
});
const view = (turn: Turn, extra: Partial<Parameters<typeof briefCardView>[0]> = {}) =>
  briefCardView({
    turn,
    latest: true,
    retryPending: false,
    stopping: false,
    phase: null,
    ...extra,
  });

describe("readHandoffSeed", () => {
  it("reads a handoff seed and ignores a fork's seed and other system turns", () => {
    expect(readHandoffSeed(seed("pending"))).toEqual({
      sourceThreadId: "source",
      sourceRef: "c1",
      sourceTitle: "Chapter 12 plan",
      cutoffTurnId: "cut",
      controlMessageId: "k",
    });
    const forkSeed = seed("complete", {
      metadata: { kind: "derivation_seed", derivation: "fork" },
    });
    expect(readHandoffSeed(forkSeed)).toBeNull();
    expect(readHandoffSeed({ ...seed("pending"), role: "user" } as Turn)).toBeNull();
  });

  it("reads the brief only from an available block", () => {
    expect(readHandoffBrief(seed("complete", { blocks: [briefBlock("available", "Plan")] }))).toBe(
      "Plan",
    );
    expect(readHandoffBrief(seed("error", { blocks: [briefBlock("unavailable", null)] }))).toBe(
      null,
    );
  });
});

describe("briefCardView", () => {
  it("generating: Stop until a Stop is in flight; running only while the lease briefs", () => {
    expect(view(seed("pending"))).toMatchObject({ state: "generating", canStop: true });
    expect(view(seed("pending"), { stopping: true }).canStop).toBe(false);
    expect(view(seed("pending"), { phase: "briefing" }).running).toBe(true);
    expect(view(seed("pending"), { phase: "generating" }).running).toBe(false);
  });

  it("ready: the brief from the block, nothing to stop or retry", () => {
    expect(view(seed("complete", { blocks: [briefBlock("available", "Plan")] }))).toMatchObject({
      state: "ready",
      brief: "Plan",
      canStop: false,
      canRetry: false,
    });
  });

  it("failed: writer copy from turn.error and Retry on the latest seed", () => {
    const failed = seed("error", { error: "This handoff brief couldn't be generated. Try again." });
    expect(view(failed)).toMatchObject({
      state: "failed",
      failureCopy: "This handoff brief couldn't be generated. Try again.",
      canRetry: true,
    });
    // A newer seed replaced it: no Retry, and no copy asking to try again.
    expect(view(failed, { latest: false })).toMatchObject({
      canRetry: false,
      failureCopy: null,
      superseded: true,
    });
    expect(view(failed, { retryPending: true }).canRetry).toBe(false);
  });

  it("stopped: Retry, and no failure copy", () => {
    expect(view(seed("cancelled"))).toMatchObject({
      state: "stopped",
      failureCopy: null,
      canRetry: true,
    });
  });
});

describe("optimisticHandoffSeed", () => {
  it("is a generating handoff seed with nothing to stop", () => {
    const optimistic = optimisticHandoffSeed({
      threadId: "t",
      sourceThreadId: "source",
      sourceTitle: "Chapter 12 plan",
      cutoffTurnId: "cut",
      createdAt: "2026-01-01T00:00:00Z",
    });
    expect(isOptimisticSeed(optimistic)).toBe(true);
    expect(isOptimisticSeed(seed("pending"))).toBe(false);
    expect(readHandoffSeed(optimistic)).toMatchObject({
      sourceThreadId: "source",
      sourceTitle: "Chapter 12 plan",
    });
    expect(view(optimistic).state).toBe("generating");
  });
});

describe("answeredControlIds", () => {
  it("counts a seed's brief control as answered: the card owns it and Stop, not Withdraw", () => {
    expect(answeredControlIds([seed("pending")]).has("k")).toBe(true);
  });
});
