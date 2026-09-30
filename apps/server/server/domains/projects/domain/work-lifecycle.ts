/** Canonical identity for a Work that became unavailable under its lifecycle lock. */
export type WorkLifecycleState = "missing" | "deleted" | "archived";

export class WorkLifecycleUnavailableError extends Error {
  constructor(
    readonly workId: string,
    readonly state: WorkLifecycleState,
    readonly workSlug?: string | null,
  ) {
    super(
      state === "archived"
        ? `Work ${workSlug ? `@${workSlug}` : workId} is archived; it is read-only until unarchived. You can unarchive it with work update status active if the writer wants that.`
        : `Work not found: ${workId}`,
    );
    this.name = "WorkLifecycleUnavailableError";
  }
}
