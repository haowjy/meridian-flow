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

  bind(externalId: string, sessionId: string): Promise<void>;

  evict(olderThan: number): Promise<void>;
}
