/**
 * Stable actor identity for external distribution modes (MCP, Pi, embedded library).
 * Survives transport reconnects; the core library operates on ActorSession only.
 */
export interface ActorSession {
  /** Stable session ID — survives reconnects. */
  id: string;
  /** Which thread/agent this session represents. */
  threadId: string;
  /** Documents initialized in this session’s runtime. */
  documents: Set<string>;
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
