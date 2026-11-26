export interface ShownBlock {
  hash: string;
  body: string;
}

export interface ObservationFrontier {
  room: string;
  snapshot: Uint8Array;
}

/**
 * A host's lookup of the model's latest read of a document: the latest frontier recorded in any of
 * the document's rooms (Live, or any draft's fork), tagged with that room. A chat can switch
 * between Live and Draft, so its latest read may be of the other room; the core checks whether
 * the room it writes in can check that read out (design §5). Never throws: an unavailable
 * frontier is `null`, the empty one.
 */
export type FrontierLookup = (documentId: string) => Promise<ObservationFrontier | null>;

/**
 * A call's lookups. `recording` chains what a result records (a sibling call's
 * result counts as seen); `planning` is the model's view as of the request that
 * produced the call (C4), which a write plans on; `reply` is what the reply has
 * itself done since that request, which the view replays after the frontier.
 */
export interface FrontierLookups {
  recording: FrontierLookup;
  /** Required for a model reply's write; a read plans nothing. */
  planning?: FrontierLookup;
  /**
   * The blocks the planning frontier's results showed in full of the document, in every room it
   * read, oldest first: what a write plans on when its latest read can't be checked out in the room
   * it writes in (history compacted below it, or a draft's read of text Live doesn't hold).
   */
  planningShown?: (documentId: string) => Promise<readonly ShownBlock[]>;
  reply?: ReplyMutations;
}

/**
 * One provider reply's own accepted mutations per document, in execution order: its writes,
 * undo, redo and revert, each as the exact bytes its command committed; and the documents it created (a create into
 * a missing or empty document), which began empty for the model. The reply owns it from its
 * first tool call to its terminal boundary, which clears it; nothing caps or evicts it before.
 */
export interface ReplyMutations {
  updates(docId: string): readonly Uint8Array[];
  append(docId: string, updates: readonly Uint8Array[]): void;
  created(docId: string): boolean;
  noteCreated(docId: string): void;
  /** What a rolled-back command leaves behind: call the returned function to put this state back. */
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
