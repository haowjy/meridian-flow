/** Durable organizer ownership; wakeups only reduce claim latency. */
export interface OrganizeClaim {
  importId: string;
  projectId: string;
  token: string;
  generation: number;
  leaseUntil: Date;
}

export interface OrganizeQueue {
  claim(): Promise<OrganizeClaim | null>;
  heartbeat(claim: OrganizeClaim): Promise<boolean>;
  /** With `retryAfterMs` the import stays leased that long, so a failed pass is not reclaimed at once. */
  release(claim: OrganizeClaim, retryAfterMs?: number): Promise<void>;
}
