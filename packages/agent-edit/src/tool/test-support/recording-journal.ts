// Recording journal fake for tool-module tests that need batch-level assertions.
import type {
  JournalBatchAppendEntry,
  JournalBatchAppendResult,
} from "../../ports/update-journal.js";
import { InMemoryAgentEditJournal } from "../../test-support/in-memory-agent-edit.js";

export class MemoryJournal extends InMemoryAgentEditJournal {
  constructor(readonly _expandEditParts = false) {
    super();
  }

  private readonly batches: string[][] = [];
  private readonly batchEntries: JournalBatchAppendEntry[][] = [];
  private nextAppendBatchFailure: unknown;

  override async appendBatch(
    entries: readonly JournalBatchAppendEntry[],
  ): Promise<JournalBatchAppendResult[]> {
    entries = entries.flatMap((entry) =>
      (entry.mutation?.editParts ?? [entry.update]).map((update) => ({ ...entry, update })),
    );
    this.batches.push(entries.map((entry) => `${entry.docId}:${entry.mutation?.turnId ?? ""}`));
    this.batchEntries.push(entries.map((entry) => ({ ...entry })));
    if (this.nextAppendBatchFailure) {
      const failure = this.nextAppendBatchFailure;
      this.nextAppendBatchFailure = undefined;
      throw failure;
    }
    return super.appendBatch(entries);
  }

  recordedBatches(): string[][] {
    return this.batches.map((batch) => [...batch]);
  }

  recordedBatchEntries(): readonly (readonly JournalBatchAppendEntry[])[] {
    return this.batchEntries;
  }

  failNextAppendBatchWith(cause: unknown): void {
    this.nextAppendBatchFailure = cause;
  }
}
