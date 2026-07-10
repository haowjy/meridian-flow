// Regression coverage for concurrent typing during whole-document overwrites.
import { describe, expect, it } from "vitest";
import { blockTexts, expectOutcome, humanText } from "./test-support/assertions.js";
import { context, harness, type WriteToolHarness } from "./test-support/write-tool-harness.js";
import type { WriteCommand } from "./types.js";

const DOC_ID = "chapter.md";
const HUMAN_MARKER = "[HUMAN-AFTER-JOURNAL]";
const BLOCK_MARKERS = ["[HUMAN-ONE]", "[HUMAN-TWO]", "[HUMAN-THREE]"] as const;

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

function codeHarnessWithHumanEditAfterAppend(): {
  ctx: WriteToolHarness;
  appendHookCount: () => number;
} {
  let ctx: WriteToolHarness | undefined;
  let hookCount = 0;
  const created = harness(
    { [DOC_ID]: "```ts\nconst base = true;\n```" },
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

function matrixHarnessWithHumanEditsAfterAppend(): WriteToolHarness {
  let ctx: WriteToolHarness | undefined;
  const created = harness(
    { [DOC_ID]: "Base paragraph.\n\nSecond paragraph.\n\nThird paragraph." },
    {
      journalOverride(journal) {
        const appendBatch = journal.appendBatch.bind(journal);
        journal.appendBatch = async (entries) => {
          const results = await appendBatch(entries);
          if (!ctx) throw new Error("Harness was not initialized before journal append");
          for (const [index, marker] of BLOCK_MARKERS.entries()) {
            humanText(ctx.liveDoc(DOC_ID), index, { from: 0, to: 0 }, marker);
          }
          return results;
        };
        return journal;
      },
    },
  );
  ctx = created;
  return created;
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
  it.each([
    { path: "staged", responseId: "response-code-overwrite" },
    { path: "immediate", responseId: undefined },
  ])("preserves concurrent code-block text on the $path overwrite path", async ({ responseId }) => {
    const { ctx, appendHookCount } = codeHarnessWithHumanEditAfterAppend();
    const result = await ctx.core.write(
      {
        command: "create",
        file: DOC_ID,
        content: "```ts\nconst replacement = true;\n```",
        overwrite: true,
      },
      {
        ...context,
        turnId: `turn-code-overwrite-${responseId ?? "immediate"}`,
        ...(responseId ? { responseId, createdDocument: false } : {}),
      },
    );
    expectOutcome(result, "success");

    if (responseId) await ctx.core.commitResponse(responseId);

    expect(appendHookCount()).toBe(1);
    expect(blockTexts(ctx.liveDoc(DOC_ID)).join("\n")).toContain(HUMAN_MARKER);
  });

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

  it.each(
    [
      {
        operation: "unrelated same-shape overwrite",
        content: "Unrelated first.\n\nUnrelated second.\n\nUnrelated third.",
        expectedSurvivors: 3,
      },
      // Structural parent deletion remains the documented residual window until
      // canonical-advancement detection can reject and replan the net diff.
      {
        operation: "shrinking overwrite",
        content: "One unrelated paragraph.",
        expectedSurvivors: 1,
      },
      {
        operation: "shrinking type-change overwrite",
        content: "# One heading",
        expectedSurvivors: 0,
      },
    ].flatMap((scenario) => [
      { ...scenario, path: "staged", responseId: `response-${scenario.operation}` },
      { ...scenario, path: "immediate", responseId: undefined },
    ]),
  )("$operation on the $path path preserves $expectedSurvivors of 3 concurrent markers", async ({
    content,
    expectedSurvivors,
    responseId,
  }) => {
    const ctx = matrixHarnessWithHumanEditsAfterAppend();
    const result = await ctx.core.write(
      { command: "create", file: DOC_ID, content, overwrite: true },
      {
        ...context,
        turnId: `turn-residual-window-${responseId ?? "immediate"}`,
        ...(responseId ? { responseId, createdDocument: false } : {}),
      },
    );
    expectOutcome(result, "success");

    if (responseId) await ctx.core.commitResponse(responseId);

    const visibleText = blockTexts(ctx.liveDoc(DOC_ID)).join("\n");
    expect(BLOCK_MARKERS.filter((marker) => visibleText.includes(marker))).toHaveLength(
      expectedSurvivors,
    );
  });
});
