// Recording journal fake for tool-module tests that need batch-level observations.
import type {
  JournalBatchAppendEntry,
  JournalBatchAppendResult,
} from "../../ports/update-journal.js";
import { InMemoryAgentEditJournal } from "../../test-support/index.js";

export class MemoryJournal extends InMemoryAgentEditJournal {
  appendBatchCalls = 0;
  appendBatchEntryOrders: string[][] = [];
  private nextAppendBatchFailure: unknown;

  override async appendBatch(
    entries: readonly JournalBatchAppendEntry[],
  ): Promise<JournalBatchAppendResult[]> {
    this.appendBatchCalls += 1;
    this.appendBatchEntryOrders.push(
      entries.map((entry) => `${entry.docId}:${entry.mutation?.turnId ?? ""}`),
    );
    if (this.nextAppendBatchFailure) {
      const failure = this.nextAppendBatchFailure;
      this.nextAppendBatchFailure = undefined;
      throw failure;
    }
    return super.appendBatch(entries);
  }

  recordedBatches(): string[][] {
    return this.appendBatchEntryOrders.map((batch) => [...batch]);
  }

  failNextAppendBatchWith(cause: unknown): void {
    this.nextAppendBatchFailure = cause;
  }
}
