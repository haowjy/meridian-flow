import type { CommandRecord, Journal, JournalChange } from "./types.js";

export function createMemoryJournal(): Journal & { failNext(error: Error): void } {
  const records = new Map<string, CommandRecord>();
  let nextSeq = 1;
  let tail: Promise<void> = Promise.resolve();
  let failure: Error | null = null;
  return {
    failNext(error) {
      failure = error;
    },
    async transact(decide) {
      const turn = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await turn;
      try {
        if (failure) {
          const error = failure;
          failure = null;
          throw error;
        }
        const { change, result } = decide({ records: [...records.values()], nextSeq });
        apply(change);
        return result;
      } finally {
        release();
      }
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
