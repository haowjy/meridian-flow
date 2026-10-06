/**
 * The model's moves and deletes of whole documents, kept as write handles.
 * They have no Yjs update; undo needs where the document was.
 */
export type AgentNamespaceChangeInput = {
  documentId: string;
  threadId: string;
  turnId: string | null;
  responseId: string | null;
  /** Where the document was: a move's old location, or the deleted document's path. */
  fromUri: string;
} & ({ kind: "move"; toUri: string } | { kind: "delete" });

export type AgentNamespaceChange = {
  id: number;
  /** The write handle, such as `w3`, on the same sequence as the document's content writes. */
  handle: string;
};

export type NamespaceChangeStatus = "active" | "reversed";

/** A recorded move or delete, as undo and redo plan it. */
export type NamespaceChangeRecord = {
  id: number;
  documentId: string;
  wId: number;
  turnId: string | null;
  fromUri: string;
  status: NamespaceChangeStatus;
  reversedAt: Date | null;
} & ({ kind: "move"; toUri: string } | { kind: "delete" });

/**
 * A copied document an undo deleted (an active `discard`): `wId` is the
 * content write that copied it, whose redo brings it back.
 */
export type DiscardedCopy = { id: number; documentId: string; wId: number; fromUri: string };

/** One content write handle on the document, by its rows in `agent_edit_mutations`. */
export type ContentWriteHandle = {
  wId: number;
  status: NamespaceChangeStatus;
  reversedAt: Date | null;
};

/** Every write handle of one document in one thread, both kinds, for undo and redo to order. */
export type WriteHandleHistory = {
  namespace: NamespaceChangeRecord[];
  content: ContentWriteHandle[];
  discardedCopy: DiscardedCopy | null;
  /** The document is soft-deleted. */
  deleted: boolean;
  /** The document was made by a copy (`metadata.copiedFrom`). */
  copied: boolean;
};

export interface AgentNamespaceChanges {
  record(change: AgentNamespaceChangeInput): Promise<AgentNamespaceChange>;
  /** Forgets a change its reply's rollback reversed, so no handle names it. */
  discard(id: number): Promise<void>;
  history(documentId: string, threadId: string): Promise<WriteHandleHistory>;
  /**
   * The document this thread deleted from `uri` and can bring back: its
   * active delete, or a copy an undo discarded. Newest first; null if none.
   */
  findDeletedAt(
    threadId: string,
    uri: string,
  ): Promise<{ documentId: string; fromUri: string } | null>;
  /** The turn's active delete of `documentId`, the one a writer's restore reverses. */
  findTurnDelete(
    threadId: string,
    turnId: string,
    documentId: string,
  ): Promise<NamespaceChangeRecord | null>;
  /**
   * Moves a change from `from` to the other status, claiming it so only one
   * undo, redo or restore acts on it. False if it wasn't at `from`.
   */
  transition(id: number, from: NamespaceChangeStatus): Promise<boolean>;
  /** Notes that an undo deleted the document content write `wId` copied in. */
  recordDiscardedCopy(input: {
    documentId: string;
    threadId: string;
    wId: number;
    fromUri: string;
  }): Promise<void>;
  /** Forgets a discarded copy once a redo brought it back. */
  forgetDiscardedCopy(id: number): Promise<void>;
}
