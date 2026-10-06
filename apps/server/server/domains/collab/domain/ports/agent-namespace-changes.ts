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

export interface AgentNamespaceChanges {
  record(change: AgentNamespaceChangeInput): Promise<AgentNamespaceChange>;
  /** Forgets a change its reply's rollback reversed, so no handle names it. */
  discard(id: number): Promise<void>;
}
