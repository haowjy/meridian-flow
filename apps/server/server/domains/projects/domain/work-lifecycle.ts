/** Canonical identity for a Work that became unavailable under its lifecycle lock. */
export type WorkLifecycleState = "missing" | "deleted" | "archived";

export class WorkLifecycleUnavailableError extends Error {
  constructor(
    readonly workId: string,
    readonly state: WorkLifecycleState,
    readonly workSlug: string | null = null,
  ) {
    super(`Work lifecycle unavailable (${state})`);
    this.name = "WorkLifecycleUnavailableError";
  }
}

/**
 * A branch named in an active-only Work write set no longer exists. Distinct from an inactive
 * Work: the caller's branch was retracted or discarded, which branch storage answers `closed`.
 */
export class DraftBranchMissingError extends Error {
  constructor(readonly branchIds: readonly string[]) {
    super("Draft branch not found");
    this.name = "DraftBranchMissingError";
  }
}
