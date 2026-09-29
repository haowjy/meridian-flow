/** Lifecycle cascade boundary for rows whose visibility is owned by a Work. */
import type { ThreadId, WorkId } from "@meridian/contracts/runtime";

export type WorkCascadeInput = {
  workId: WorkId;
  threadIds: readonly ThreadId[];
  liveThreadIds: readonly ThreadId[];
  at: Date;
};

export interface WorkCascade {
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  hide(input: WorkCascadeInput): Promise<ThreadId[]>;
  unhide(input: WorkCascadeInput): Promise<void>;
}
