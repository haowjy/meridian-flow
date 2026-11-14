import type { CommandRecord, Journal, JournalChange } from "./types.js";

/** A journal in memory, with the same one-transaction-at-a-time rule as the browser's. */
export function createMemoryJournal(): Journal & { failNext(error: Error): void } {
  const records = new Map<string, CommandRecord>();
  let nextSeq = 1;
  let tail: Promise<unknown> = Promise.resolve();
  let failure: Error | null = null;
  return {
    failNext(error) {
      failure = error;
    },
    transact(decide) {
      const run = tail.then(() => {
        if (failure) {
          const error = failure;
          failure = null;
          throw error;
        }
        const { change, result } = decide({ records: [...records.values()], nextSeq });
        apply(change);
        return result;
      });
      tail = run.catch(() => undefined);
      return run;
    },
    read: () => Promise.resolve([...records.values()]),
    close() {},
  };

  function apply(change: JournalChange) {
    for (const record of change.put ?? []) records.set(record.id, structuredClone(record));
    for (const id of change.remove ?? []) records.delete(id);
    if (change.nextSeq !== undefined) nextSeq = change.nextSeq;
  }
}
