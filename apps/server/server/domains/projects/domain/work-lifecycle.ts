/** Canonical identity for a Work that became unavailable under its lifecycle lock. */
export type WorkLifecycleState = "missing" | "deleted";

export class WorkLifecycleUnavailableError extends Error {
  constructor(
    readonly workId: string,
    readonly state: WorkLifecycleState,
  ) {
    super(`Work not found: ${workId}`);
    this.name = "WorkLifecycleUnavailableError";
  }
}
