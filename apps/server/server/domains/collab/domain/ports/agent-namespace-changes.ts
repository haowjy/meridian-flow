/**
 * The model's creates, moves and deletes of whole documents, kept as write
 * handles. They have no Yjs update; undo and redo need where the document was.
 */

/** A change as it acts on the tree: enough to apply it either way. */
export type NamespaceChangeShape =
  | { kind: "create"; fromUri: string }
  | { kind: "move"; fromUri: string; toUri: string }
  | { kind: "delete"; fromUri: string };

export type NamespaceChangeOwner = {
  documentId: string;
  threadId: string;
  turnId: string | null;
  /** The Work draft the change lands in; null for live. Undo reverses it where it landed. */
  draftBranchId: string | null;
};

type NamespaceChangeStatus = "active" | "reversed";

/** A recorded change, as undo and redo plan it. */
export type NamespaceChangeRecord = NamespaceChangeShape & {
  id: number;
  documentId: string;
  /** The write handle's ordinal (`w3`), on the same sequence as the document's content writes. */
  wId: number;
  turnId: string | null;
  /** The Work draft it landed in; null when it landed live. */
  draftBranchId: string | null;
  status: NamespaceChangeStatus;
  reversedAt: Date | null;
};

/**
 * One content write handle on the document: live by its rows in
 * `agent_edit_mutations`, drafted by its rows in `branch_write_journal`.
 */
export type ContentWriteHandle = {
  wId: number;
  status: NamespaceChangeStatus;
  reversedAt: Date | null;
};

/** Every write handle of one document in one thread, both kinds, for undo and redo to order. */
export type WriteHandleHistory = {
  namespace: NamespaceChangeRecord[];
  content: ContentWriteHandle[];
};

export interface AgentNamespaceChangeStore {
  /** Records a move or delete on a new handle. */
  record(
    change: NamespaceChangeOwner & Exclude<NamespaceChangeShape, { kind: "create" }>,
  ): Promise<NamespaceChangeRecord>;
  /** Records a create on the handle of the content write that made the document. */
  recordCreate(change: NamespaceChangeOwner & { wId: number; fromUri: string }): Promise<number>;
  /** Forgets changes whose reply rolled back, so no handle names them. */
  discard(ids: readonly number[]): Promise<void>;
  /** Indexed existence check, before loading mixed content and namespace history. */
  hasHistory(documentId: string, threadId: string): Promise<boolean>;
  /** The recorded changes and the live content handles; the facade adds drafted ones. */
  history(documentId: string, threadId: string): Promise<WriteHandleHistory>;
  /** The turn's changes in `status`, every document, by handle. */
  forTurn(
    threadId: string,
    turnId: string,
    status: NamespaceChangeStatus,
  ): Promise<NamespaceChangeRecord[]>;
  /**
   * The document this thread removed from `uri`, by an active delete or an
   * undone create. Newest first; null if none.
   */
  findDeletedAt(
    threadId: string,
    uri: string,
  ): Promise<{ documentId: string; fromUri: string } | null>;
  /** The selected delete and the document's current live state, for Restore. */
  findTurnDelete(
    threadId: string,
    turnId: string,
    documentId: string,
    wId: number,
  ): Promise<(NamespaceChangeRecord & { documentLive: boolean }) | null>;
  /**
   * Moves a change from `from` to the other status, claiming it so only one
   * undo, redo or restore acts on it. False if it wasn't at `from`.
   */
  transition(id: number, from: NamespaceChangeStatus): Promise<boolean>;
}
