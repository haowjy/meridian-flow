/** Per-document snapshot state tracked for an external actor session. */
export interface ActorSessionDocumentState {
  /** State vector at last sync with the live document. */
  stateVector: Uint8Array;
  /** Full Yjs state at last committed write. Used as concurrent detection baseline. */
  committedSnapshot?: Uint8Array;
}

/**
 * Stable actor identity for external distribution modes (MCP, Pi, embedded library).
 * Survives transport reconnects; the core library operates on ActorSession only.
 */
export interface ActorSession {
  /** Stable session ID — survives reconnects. */
  id: string;
  /** Which thread/agent this session represents. */
  threadId: string;
  /** Per-document local snapshot state. */
  documents: Map<string, ActorSessionDocumentState>;
}

/**
 * Maps external caller identity to stable ActorSession instances.
 * Transport adapters (MCP token, Pi conversation ID) bind onto this store.
 */
export interface ActorSessionStore {
  /**
   * Get or create a session for an external caller.
   * Returns the same session for a previously bound externalId.
   */
  resolve(externalId: string): Promise<ActorSession>;

  /**
   * Map host identity to a stable session ID.
   * Rejects when sessionId does not exist or externalId is already bound elsewhere.
   */
  bind(externalId: string, sessionId: string): Promise<void>;

  /**
   * Clean up sessions whose last activity is older than olderThan (epoch ms).
   * Returns when expired sessions are removed from the store.
   */
  evict(olderThan: number): Promise<void>;
}
