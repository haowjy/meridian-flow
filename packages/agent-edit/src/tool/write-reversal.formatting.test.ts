// Write-level reversal response-format and no-leak contracts.
import { describe, expect, it } from "vitest";
import {
  blockTexts,
  expectNoInternalIds,
  hashAt,
  humanText,
  outcomeText,
} from "./test-support/assertions.js";
import {
  deletedBlockScenario,
  type NoInternalIdState,
  ReversalScenario,
  simpleReplaceScenario,
} from "./test-support/write-reversal-scenario.js";
import { context } from "./test-support/write-tool-harness.js";
import type { WriteOutcome } from "./types.js";

type NoInternalIdCase = {
  label: string;
  setup: () => Promise<NoInternalIdState>;
  run: (state: NoInternalIdState) => Promise<string | WriteOutcome>;
  assertExtra?: (state: NoInternalIdState, text: string) => void | Promise<void>;
};

const noInternalIdCases: NoInternalIdCase[] = [
  {
    label: "full undo",
    setup: () => deletedBlockScenario("turn-response-format-undo"),
    run: ({ ctx }) => ctx.core.write({ command: "undo", file: "chapter.md" }, context),
    assertExtra: ({ originalHash }, text) => {
      const lines = text.split("\n");
      expect(lines.slice(0, 4)).toEqual(["status: reversed", "", "undo: 1 edit(s)", ""]);
      expect(lines[4]).toMatch(/^[0-9a-f]{4}\|Beta waits in the clearing, sword drawn\.$/);
      expect(lines[4]?.split("|")[0]).not.toBe(originalHash);
    },
  },
  {
    label: "full redo",
    setup: async () => {
      const state = await deletedBlockScenario("turn-response-format-redo");
      await state.ctx.core.write({ command: "undo", file: "chapter.md" }, context);
      return state;
    },
    run: ({ ctx }) => ctx.core.write({ command: "redo", file: "chapter.md" }, context),
    assertExtra: (_state, text) => {
      expect(text.split("\n").slice(0, 4)).toEqual(["status: reversed", "", "redo: 1 edit(s)", ""]);
    },
  },
  {
    label: "reconciled undo",
    setup: async () => {
      const state = await simpleReplaceScenario("turn-reconciled-undo");
      humanText(state.ctx.liveDoc("chapter.md"), 0, { from: 0, to: 0 }, "Human ");
      return state;
    },
    run: ({ ctx }) => ctx.core.write({ command: "undo", file: "chapter.md" }, context),
    assertExtra: ({ ctx }, text) => {
      expect(text).toContain("status: reconciled");
      expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Human Alpha sword."]);
    },
  },
  {
    label: "reconciled redo",
    setup: async () => {
      const state = await simpleReplaceScenario("turn-reconciled-redo");
      await state.ctx.core.write({ command: "undo", file: "chapter.md" }, context);
      humanText(state.ctx.liveDoc("chapter.md"), 0, { from: 0, to: 0 }, "Human ");
      return state;
    },
    run: ({ ctx }) => ctx.core.write({ command: "redo", file: "chapter.md" }, context),
    assertExtra: ({ ctx }, text) => {
      expect(text).toContain("status: reconciled");
      expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Human Alpha blade."]);
    },
  },
];

describe("write reversal formatting", () => {
  it("returns write ids in immediate results even when the echo is suppressed", async () => {
    const scenario = await ReversalScenario.view({ "chapter.md": "Alpha sword." });

    const write = await scenario.ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      context,
    );

    expect(write.writeId).toBe("w1");
    expect(outcomeText(write)).toContain("write id: w1");
  });

  it.each(noInternalIdCases)("does not leak internal ids in $label", async ({
    setup,
    run,
    assertExtra,
  }) => {
    const state = await setup();
    const output = await run(state);
    const text = outcomeText(output);

    expectNoInternalIds(text);
    await assertExtra?.(state, text);
  });

  it("preserves changed block hashes in reversal output without exposing storage ids", async () => {
    const scenario = await ReversalScenario.view({
      "chapter.md":
        "Beta waits in the clearing, sword drawn.\n\nThe wind carries the scent of rain.",
    });
    const originalHash = hashAt(scenario.ctx.liveDoc("chapter.md"), 0);
    await scenario.deletedFirstBlock("turn-format-hash");

    const undo = await scenario.ctx.core.write({ command: "undo", file: "chapter.md" }, context);
    const text = outcomeText(undo);

    expectNoInternalIds(text);
    expect(text).toMatch(/^[0-9a-f]{4}\|Beta waits in the clearing, sword drawn\.$/m);
    expect(text).not.toContain(`${originalHash}|`);
  });
});
