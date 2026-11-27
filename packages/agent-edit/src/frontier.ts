export interface ShownBlock {
  hash: string;
  body: string;
}

export interface ObservationFrontier {
  room: string;
  snapshot: Uint8Array;
}

export type FrontierLookup = (documentId: string) => Promise<ObservationFrontier | null>;

export interface FrontierLookups {
  recording: FrontierLookup;
  planning?: FrontierLookup;
  planningShown?: (documentId: string) => Promise<readonly ShownBlock[]>;
  reply?: ReplyMutations;
}

export interface ReplyMutations {
  updates(docId: string): readonly Uint8Array[];
  append(docId: string, updates: readonly Uint8Array[]): void;
  created(docId: string): boolean;
  noteCreated(docId: string): void;
  checkpoint(): () => void;
  clear(): void;
}

export function createReplyMutations(): ReplyMutations {
  const docs = new Map<string, Uint8Array[]>();
  const created = new Set<string>();
  return {
    updates: (docId) => docs.get(docId) ?? [],
    append(docId, updates) {
      if (updates.length) docs.set(docId, [...(docs.get(docId) ?? []), ...updates]);
    },
    created: (docId) => created.has(docId),
    noteCreated: (docId) => created.add(docId),
    checkpoint() {
      const kept = new Map(docs);
      const keptCreated = new Set(created);
      return () => {
        docs.clear();
        for (const [docId, updates] of kept) docs.set(docId, updates);
        created.clear();
        for (const docId of keptCreated) created.add(docId);
      };
    },
    clear() {
      docs.clear();
      created.clear();
    },
  };
}
