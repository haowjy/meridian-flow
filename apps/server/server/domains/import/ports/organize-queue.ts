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
  release(claim: OrganizeClaim): Promise<void>;
}
