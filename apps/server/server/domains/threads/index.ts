export type EventJournalReader = {
  headSeq(_threadId: string): Promise<string>;
};

export type EventJournalWriter = {
  append(_input: { threadId: string; payload: unknown }): Promise<string>;
};

export type ThreadRepositories = {
  readonly phase: "skeleton";
};

export type ThreadEventHub = {
  readonly phase: "skeleton";
};

export function createInMemoryEventJournalReader(): EventJournalReader {
  return {
    async headSeq() {
      return "0";
    },
  };
}

export function createInMemoryEventJournalWriter(): EventJournalWriter {
  return {
    async append() {
      return "1";
    },
  };
}

export function createInMemoryRepositories(): ThreadRepositories {
  return { phase: "skeleton" };
}

export function createThreadEventHub(): ThreadEventHub {
  return { phase: "skeleton" };
}

export function createDrizzleEventJournalReader(_db: unknown): EventJournalReader {
  return createInMemoryEventJournalReader();
}

export function createDrizzleEventJournalWriter(_db: unknown): EventJournalWriter {
  return createInMemoryEventJournalWriter();
}

export function createDrizzleRepositories(_db: unknown): ThreadRepositories {
  return createInMemoryRepositories();
}
