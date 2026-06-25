// Response-staging fixture that drives staged writes through the real in-memory core.
import { context, harness } from "./write-tool-harness.js";

export async function responseStagingHarness(responseId: string) {
  const ctx = harness({ "alpha.md": "Alpha.", "beta.md": "Beta." });
  await ctx.core.write({ command: "view", file: "alpha.md" }, context);
  await ctx.core.write({ command: "view", file: "beta.md" }, context);

  return {
    ctx,
    async stageInsert(file: "alpha.md" | "beta.md", content: string, turnId: string) {
      return ctx.core.write(
        { command: "insert", file, content },
        { ...context, responseId, turnId },
      );
    },
    commit: () => ctx.core.commitResponse(responseId),
    recordedBatches: () => ctx.journal.recordedBatches(),
    updateSeqs: async (file: string) =>
      (await ctx.journal.read(file)).updates.map((update) => update.seq),
  };
}
