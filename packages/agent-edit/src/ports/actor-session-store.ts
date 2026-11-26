export interface ActorSession {
  id: string;
  threadId: string;
}

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
