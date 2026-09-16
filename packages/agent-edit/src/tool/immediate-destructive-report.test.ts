// Immediate destructive-reporting matrix at the public tool boundary.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { expectOutcome, humanText } from "./test-support/assertions.js";
import { harness } from "./test-support/write-tool-harness.js";

const DOC_ID = "chapter.md";

describe("immediate destructive reporting", () => {
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
});
