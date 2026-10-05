// Scenario builder for write-reversal tests that keeps harness setup and staged writes in one place.

import * as Y from "yjs";
import { blockTexts } from "./assertions.js";
import { context, harness, type WriteToolHarness } from "./write-tool-harness.js";

export class ReversalScenario {
  readonly ctx: WriteToolHarness;

  private constructor(ctx: WriteToolHarness) {
    this.ctx = ctx;
  }

  static async read(
    initialDocs: Record<string, string> = { "chapter.md": "Base." },
    options?: Parameters<typeof harness>[1],
  ): Promise<ReversalScenario> {
    const ctx = harness(initialDocs, options);
    await ctx.core.read({ file: "chapter.md" }, context);
    return new ReversalScenario(ctx);
  }

  async appendBlocks(blocks: readonly string[], turnId = "turn-append"): Promise<void> {
    for (const [index, block] of blocks.entries()) {
      await this.ctx.core.write(
        { command: "insert", file: "chapter.md", content: block },
        { ...context, turnId: `${turnId}-${index}` },
      );
    }
  }

  async checkpointLiveDoc(upToSeq: number, docId = "chapter.md"): Promise<void> {
    await this.ctx.journal.checkpoint(
      docId,
      Y.encodeStateAsUpdate(this.ctx.liveDoc(docId)),
      upToSeq,
    );
  }

  async mutationsFor(writeId: string) {
    return this.ctx.journal.mutationsForWrite("chapter.md", context.threadId, writeId);
  }

  blockTexts(): string[] {
    return blockTexts(this.ctx.liveDoc("chapter.md"));
  }
}
