// Regression coverage for concurrent typing during whole-document overwrites.
import { describe, expect, it } from "vitest";
import { blockTexts, expectOutcome, humanText } from "./test-support/assertions.js";
import { context, harness, type WriteToolHarness } from "./test-support/write-tool-harness.js";
import type { WriteCommand } from "./types.js";

const DOC_ID = "chapter.md";
const HUMAN_MARKER = "[HUMAN-AFTER-JOURNAL]";

function harnessWithHumanEditAfterAppend(): {
  ctx: WriteToolHarness;
  appendHookCount: () => number;
} {
  let ctx: WriteToolHarness | undefined;
  let hookCount = 0;
  const created = harness(
    { [DOC_ID]: "Base paragraph.\n\nSecond paragraph.\n\nThird paragraph." },
    {
      journalOverride(journal) {
        const appendBatch = journal.appendBatch.bind(journal);
        journal.appendBatch = async (entries) => {
          const results = await appendBatch(entries);
          hookCount += 1;
          if (!ctx) throw new Error("Harness was not initialized before journal append");
          humanText(ctx.liveDoc(DOC_ID), 0, { from: 0, to: 0 }, HUMAN_MARKER);
          return results;
        };
        return journal;
      },
    },
  );
  ctx = created;
  return { ctx: created, appendHookCount: () => hookCount };
}

const scenarios: Array<{
  operation: string;
  command: WriteCommand;
  markerSurvives: boolean;
}> = [
  {
    operation: "inline replace",
    command: {
      command: "replace",
      file: DOC_ID,
      find: "Base paragraph.",
      content: "Agent inline replacement.",
    },
    markerSurvives: true,
  },
  {
    operation: "multi-block delete",
    command: {
      command: "replace",
      file: DOC_ID,
      find: "Base paragraph.\n\nSecond paragraph.",
      content: "",
    },
    markerSurvives: false,
  },
  {
    operation: "block-type change",
    command: {
      command: "replace",
      file: DOC_ID,
      find: "Base paragraph.",
      content: "# Agent heading",
    },
    markerSurvives: false,
  },
  {
    operation: "full overwrite",
    command: {
      command: "create",
      file: DOC_ID,
      content: "Agent replacement.",
      overwrite: true,
    },
    markerSurvives: true,
  },
];

describe("concurrent structural mutation matrix", () => {
  it.each(
    scenarios.flatMap((scenario) => [
      { ...scenario, path: "staged", responseId: `response-${scenario.operation}` },
      { ...scenario, path: "immediate", responseId: undefined },
    ]),
  )("$operation on the $path path has the intended parent-identity semantics", async ({
    command,
    markerSurvives,
    responseId,
  }) => {
    const { ctx, appendHookCount } = harnessWithHumanEditAfterAppend();
    const result = await ctx.core.write(command, {
      ...context,
      turnId: `turn-concurrent-overwrite-${responseId ?? "immediate"}`,
      ...(responseId ? { responseId, createdDocument: false } : {}),
    });
    expectOutcome(result, "success");

    if (responseId) {
      expect(appendHookCount()).toBe(0);
      await ctx.core.commitResponse(responseId);
    }

    expect(appendHookCount()).toBe(1);
    const visibleText = blockTexts(ctx.liveDoc(DOC_ID)).join("\n");
    if (markerSurvives) expect(visibleText).toContain(HUMAN_MARKER);
    else expect(visibleText).not.toContain(HUMAN_MARKER);
  });
});
