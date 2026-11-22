/**
 * Observation frontiers: what document state a model was shown. A frontier holds the frontiers of
 * each doc a result showed, in the copy it was rendered from (`loro-frontier.ts`). The host names
 * rooms.
 */

/** One block a result showed the model in full, in the view it was read in; later showings last. */
export interface ShownBlock {
  hash: string;
  body: string;
  view: "live" | "draft";
}

export interface ObservationFrontier {
  /** The host's opaque label for the room the document belongs to; carried, never read. */
  room: string;
  /** `encodeFrontierMap` of the docs the result showed, at the copy it was rendered from. */
  snapshot: Uint8Array;
}

/**
 * A host's lookup of the model's latest frontier for a room. Never throws: an
 * unavailable frontier is `null`, the empty one.
 */
export type FrontierLookup = (room: string) => Promise<ObservationFrontier | null>;

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
   * The blocks the planning frontier's results showed in full in `room`, oldest first: what a
   * write plans on when its frontier can't be compared with the room (history compacted below it).
   */
  planningShown?: (room: string) => Promise<readonly ShownBlock[]>;
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
