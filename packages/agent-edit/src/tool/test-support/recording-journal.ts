// Recording journal fake for tool-module tests that need batch-level observations.
import type {
  JournalBatchAppendEntry,
  JournalBatchAppendResult,
} from "../../ports/update-journal.js";
import { InMemoryAgentEditJournal } from "../../test-support/index.js";

export class MemoryJournal extends InMemoryAgentEditJournal {
  private readonly batches: string[][] = [];
  private nextAppendBatchFailure: unknown;

  override async appendBatch(
    entries: readonly JournalBatchAppendEntry[],
  ): Promise<JournalBatchAppendResult[]> {
    this.batches.push(entries.map((entry) => `${entry.docId}:${entry.mutation?.turnId ?? ""}`));
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

  failNextAppendBatchWith(cause: unknown): void {
    this.nextAppendBatchFailure = cause;
  }
}
