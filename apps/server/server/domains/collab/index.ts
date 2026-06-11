export type DocumentSyncService = {
  readonly phase: "skeleton";
};

export type DocumentStore = {
  readonly phase: "skeleton";
};

export function createDocumentSyncService(): DocumentSyncService {
  return { phase: "skeleton" };
}

export function createInMemoryDocumentStore(): DocumentStore {
  return { phase: "skeleton" };
}

export function createDrizzleDocumentStore(_db: unknown): DocumentStore {
  return createInMemoryDocumentStore();
}
