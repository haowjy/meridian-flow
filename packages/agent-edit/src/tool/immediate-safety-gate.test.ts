// Immediate-write safety matrix at the public tool boundary.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import type { ActorSession } from "../ports/actor-session-store.js";
import { blockTexts, expectOutcome, hashAt, humanText } from "./test-support/assertions.js";
import { context, harness, type WriteToolHarness } from "./test-support/write-tool-harness.js";

const DOC_ID = "chapter.md";

describe("immediate destructive-write safety gate", () => {
  it("rejects delete after a human edits its parent, without journaling", async () => {
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

    expectOutcome(outcome, "destructive_write_rejected", true);
    expect(outcome.text).toContain(deletedHash);
    expect(ctx.journal.recordedBatches()).toEqual([]);
    expect(session.documents.has(DOC_ID)).toBe(false);
    expect(blockTexts(ctx.liveDoc(DOC_ID))).toEqual(["Writer: Alpha.", "Beta.", "Gamma."]);
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
    return update.length > 0 ? [{ update, origin: { type: "human" } }] : [];
  };
}
