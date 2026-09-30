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
