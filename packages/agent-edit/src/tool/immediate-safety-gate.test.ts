// Immediate-write safety matrix at the public tool boundary.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import type { ActorSession } from "../ports/actor-session-store.js";
import { blockTexts, expectOutcome, hashAt, humanText } from "./test-support/assertions.js";
import { context, harness, type WriteToolHarness } from "./test-support/write-tool-harness.js";

const DOC_ID = "chapter.md";

describe("immediate destructive-write safety gate", () => {
  it("journals a human mutation without creating agent turn metadata", async () => {
    const ctx = harness({ [DOC_ID]: "Alpha." });
    const outcome = await ctx.core.write(
      { command: "create", file: DOC_ID, content: "Human rewrite.", overwrite: true },
      {
        sessionId: "human-session",
        actor: { kind: "human", userId: "user-1", threadId: "thread-a" },
      },
    );

    expectOutcome(outcome, "success");
    expect(ctx.journal.recordedBatchEntries()[0]?.[0]?.mutation).toMatchObject({
      actorKind: "human",
      userId: "user-1",
      turnId: null,
    });
    expect(ctx.journal.recordedBatchEntries()[0]?.[0]?.meta).toEqual({
      origin: "human:user-1",
      seq: 0,
    });
  });

  it("allows a human destructive write over a concurrent agent edit", async () => {
    const ctx = harness({ [DOC_ID]: "Alpha.\n\nBeta." });
    let injected = false;
    ctx.coordinator.concurrentUpdatesSince = async ({ doc, sinceStateVector }) => {
      if (!injected) {
        injected = true;
        humanText(doc, 1, { from: 0, to: 0 }, "Agent: ");
      }
      const update = Y.encodeStateAsUpdate(doc, sinceStateVector);
      return update.length > 0
        ? [{ update, origin: { type: "agent", actorTurnId: "other-turn" } }]
        : [];
    };

    const outcome = await ctx.core.write(
      { command: "create", file: DOC_ID, content: "Replacement.", overwrite: true },
      {
        sessionId: "human-session",
        actor: { kind: "human", userId: "user-1", threadId: "thread-a" },
      },
    );

    expectOutcome(outcome, "success");
    expect(ctx.journal.recordedBatches()).toHaveLength(1);
  });

  it("does not reject a human actor against that same user's own update", async () => {
    const ctx = harness({ [DOC_ID]: "Alpha.\n\nBeta." });
    let injected = false;
    ctx.coordinator.concurrentUpdatesSince = async ({ doc, sinceStateVector }) => {
      if (!injected) {
        injected = true;
        humanText(doc, 1, { from: 0, to: 0 }, "Self: ");
      }
      const update = Y.encodeStateAsUpdate(doc, sinceStateVector);
      return update.length > 0 ? [{ update, origin: { type: "human", userId: "user-1" } }] : [];
    };

    const outcome = await ctx.core.write(
      { command: "create", file: DOC_ID, content: "Replacement.", overwrite: true },
      {
        sessionId: "human-session",
        actor: { kind: "human", userId: "user-1", threadId: "thread-a" },
      },
    );

    expectOutcome(outcome, "success");
    expect(ctx.journal.recordedBatches()).toHaveLength(1);
  });

  it("reports delete after a human edits its parent and keeps the merge", async () => {
    const ctx = harness({ [DOC_ID]: "Alpha.\n\nBeta.\n\nGamma." });
    const deletedHash = hashAt(ctx.liveDoc(DOC_ID), 0);
    const session: ActorSession = {
      id: "session-reject",
      threadId: "thread-a",
      documents: new Map(),
    };
    injectConcurrentHumanEdit(ctx, 0);

    const outcome = await ctx.core.write(
      { command: "replace", file: DOC_ID, find: "Alpha.\n\nBeta.", content: "" },
      { ...context, session, turnId: "turn-rejected-delete" },
    );

    expectOutcome(outcome, "success");
    expect(outcome.text).toContain(`swept: ${deletedHash}|Writer: Alpha.`);
    expect(ctx.journal.recordedBatches()).toHaveLength(1);
    expect(blockTexts(ctx.liveDoc(DOC_ID))).toEqual(["Gamma."]);
  });

  it("allows a pure insert despite a concurrent edit", async () => {
    const ctx = harness({ [DOC_ID]: "Alpha." });
    injectConcurrentHumanEdit(ctx, 0);

    const outcome = await ctx.core.write(
      { command: "insert", file: DOC_ID, content: "Beta." },
      { ...context, turnId: "turn-safe-insert" },
    );

    expectOutcome(outcome, "success");
    expect(ctx.journal.recordedBatches()).toHaveLength(1);
    expect(blockTexts(ctx.liveDoc(DOC_ID)).join(" ")).toContain("Writer: Alpha.");
  });

  it("allows a destructive mutation when there is no concurrent edit", async () => {
    const ctx = harness({ [DOC_ID]: "Alpha.\n\nBeta.\n\nGamma." });

    const outcome = await ctx.core.write(
      { command: "replace", file: DOC_ID, find: "Alpha.\n\nBeta.", content: "" },
      { ...context, turnId: "turn-safe-delete" },
    );

    expectOutcome(outcome, "success");
    expect(ctx.journal.recordedBatches()).toHaveLength(1);
    expect(blockTexts(ctx.liveDoc(DOC_ID))).toEqual(["Gamma."]);
  });

  it("allows a compatible-type overwrite and preserves the parent identity", async () => {
    const ctx = harness({ [DOC_ID]: "Alpha." });
    const originalHash = hashAt(ctx.liveDoc(DOC_ID), 0);
    injectConcurrentHumanEdit(ctx, 0);

    const outcome = await ctx.core.write(
      { command: "replace", file: DOC_ID, find: "Alpha.", content: "Agent." },
      { ...context, turnId: "turn-compatible-overwrite" },
    );

    expectOutcome(outcome, "success");
    expect(hashAt(ctx.liveDoc(DOC_ID), 0)).toBe(originalHash);
    expect(blockTexts(ctx.liveDoc(DOC_ID))[0]).toContain("Writer:");
    expect(ctx.journal.recordedBatches()).toHaveLength(1);
  });
});

function injectConcurrentHumanEdit(ctx: WriteToolHarness, blockIndex: number): void {
  let injected = false;
  ctx.coordinator.concurrentUpdatesSince = async ({ doc, sinceStateVector }) => {
    if (!injected) {
      injected = true;
      humanText(doc, blockIndex, { from: 0, to: 0 }, "Writer: ");
    }
    const update = Y.encodeStateAsUpdate(doc, sinceStateVector);
    return update.length > 0 ? [{ update, origin: { type: "human", userId: "human-1" } }] : [];
  };
}
