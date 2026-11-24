export interface OrganizeClaim {
  importId: string;
  projectId: string;
  token: string;
  leaseUntil: Date;
}

export interface OrganizeQueue {
  claim(): Promise<OrganizeClaim | null>;
  heartbeat(claim: OrganizeClaim): Promise<boolean>;
  release(claim: OrganizeClaim, retryAfterMs?: number): Promise<void>;
}
