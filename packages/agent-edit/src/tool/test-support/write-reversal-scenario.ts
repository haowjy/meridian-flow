// Scenario builder for write-reversal tests that keeps harness setup and staged writes in one place.

import * as Y from "yjs";
import type { ReversalStatus } from "../../ports/types.js";
import type { ReversalStore, UpdateJournal, WriteMutationRow } from "../../ports/update-journal.js";

import { blockTexts, hashAt } from "./assertions.js";
import type { MemoryJournal } from "./recording-journal.js";
import { context, harness, type WriteToolHarness } from "./write-tool-harness.js";

export type NoInternalIdState = {
  ctx: WriteToolHarness;
  originalHash?: string;
};

export class ReversalScenario {
  readonly ctx: WriteToolHarness;

  private constructor(ctx: WriteToolHarness) {
    this.ctx = ctx;
  }

  static async view(
    initialDocs: Record<string, string> = { "chapter.md": "Base." },
    options?: Parameters<typeof harness>[1],
  ): Promise<ReversalScenario> {
    const ctx = harness(initialDocs, options);
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    return new ReversalScenario(ctx);
  }

  static raw(
    initialDocs: Record<string, string> = { "chapter.md": "Base." },
    options?: Parameters<typeof harness>[1],
  ): ReversalScenario {
    return new ReversalScenario(harness(initialDocs, options));
  }

  async appendBlocks(blocks: readonly string[], turnId = "turn-append"): Promise<void> {
    for (const [index, block] of blocks.entries()) {
      await this.ctx.core.write(
        { command: "insert", file: "chapter.md", content: block },
        { ...context, turnId: `${turnId}-${index}` },
      );
    }
  }

  async writeDependentSwordSaber(): Promise<void> {
    await this.ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      { ...context, turnId: "turn-dependent-writes" },
    );
    await this.ctx.core.write(
      { command: "replace", file: "chapter.md", content: "saber", find: "blade" },
      { ...context, turnId: "turn-dependent-writes" },
    );
  }

  async checkpointLiveDoc(upToSeq: number, docId = "chapter.md"): Promise<void> {
    await this.ctx.journal.checkpoint(
      docId,
      Y.encodeStateAsUpdate(this.ctx.liveDoc(docId)),
      upToSeq,
    );
  }

  async simpleReplace(turnId: string): Promise<void> {
    await this.ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      { ...context, turnId },
    );
  }

  async deletedFirstBlock(turnId: string): Promise<{ originalHash: string }> {
    const originalHash = hashAt(this.ctx.liveDoc("chapter.md"), 0);
    await this.ctx.core.write(
      { command: "replace", file: `chapter.md#${originalHash}`, content: "" },
      { ...context, turnId },
    );
    return { originalHash };
  }

  async mutationsFor(writeId: string) {
    return this.ctx.journal.mutationsForWrite("chapter.md", context.threadId, writeId);
  }

  blockTexts(): string[] {
    return blockTexts(this.ctx.liveDoc("chapter.md"));
  }
}

export async function deletedBlockScenario(turnId: string): Promise<NoInternalIdState> {
  const scenario = await ReversalScenario.view({
    "chapter.md": "Beta waits in the clearing, sword drawn.\n\nThe wind carries the scent of rain.",
  });
  const { originalHash } = await scenario.deletedFirstBlock(turnId);
  return { ctx: scenario.ctx, originalHash };
}

export async function simpleReplaceScenario(
  turnId: string,
  options?: Parameters<typeof harness>[1],
): Promise<NoInternalIdState> {
  const scenario = await ReversalScenario.view({ "chapter.md": "Alpha sword." }, options);
  await scenario.simpleReplace(turnId);
  return { ctx: scenario.ctx };
}

export function journalWithMissingMutationTarget(
  journal: MemoryJournal,
  missing: Pick<WriteMutationRow, "status" | "createdSeq" | "undoUpdateSeq"> & {
    writeId: string;
  },
): UpdateJournal & ReversalStore {
  return {
    append: journal.append.bind(journal),
    reserveWriteOrdinal: journal.reserveWriteOrdinal.bind(journal),
    appendBatch: journal.appendBatch.bind(journal),
    latestActiveWrite: journal.latestActiveWrite.bind(journal),
    activeWriteSummary: journal.activeWriteSummary.bind(journal),
    writeMinCreatedSeq: journal.writeMinCreatedSeq.bind(journal),
    mutationsForWrite: async (documentId, threadId, handle) => {
      const rows = await journal.mutationsForWrite(documentId, threadId, handle);
      if (handle !== missing.writeId) return rows;
      const source = rows[0];
      if (!source) return rows;
      return [
        ...rows,
        {
          writeId: source.writeId,
          handle: source.handle,
          wId: source.wId,
          turnId: source.turnId,
          createdSeq: missing.createdSeq,
          status: missing.status,
          ...(missing.undoUpdateSeq !== undefined ? { undoUpdateSeq: missing.undoUpdateSeq } : {}),
        },
      ];
    },
    read: journal.read.bind(journal),
    readForReconstruction: journal.readForReconstruction.bind(journal),
    checkpoint: journal.checkpoint.bind(journal),
    compact: journal.compact.bind(journal),
    persistUndo: journal.persistUndo.bind(journal),
    persistRedo: journal.persistRedo.bind(journal),
    readReversals: journal.readReversals.bind(journal),
  };
}

export function markStoredReversalStatus(
  journal: MemoryJournal,
  docId: string,
  writeId: string,
  status: ReversalStatus,
): void {
  const entry = journal.debugEntry(docId);
  const stored = [...(entry?.reversals.values() ?? [])].find((candidate) =>
    candidate.record.writeIds.includes(writeId),
  );
  if (!stored) throw new Error(`missing stored reversal for ${writeId}`);
  stored.record.status = status;
}

export function setStoredUpdateTime(
  journal: MemoryJournal,
  docId: string,
  seq: number,
  storedAt: Date,
): void {
  const entry = journal.debugEntry(docId);
  const update = entry?.updates.find((candidate) => candidate.seq === seq);
  if (!update) throw new Error(`missing stored update seq ${seq}`);
  update.storedAt = storedAt;
}
