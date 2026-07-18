/** Persistence boundary for one user's cross-device working-set snapshot in a project. */
import type { WorkingSetRoute } from "@meridian/contracts/protocol";
import type { ProjectId, ThreadId, UserId } from "@meridian/contracts/runtime";

export type WorkingSetSnapshot = {
  recentRoutes: WorkingSetRoute[];
  lastThreadId: ThreadId | null;
};

export type WorkingSetRow = WorkingSetSnapshot & {
  userId: UserId;
  projectId: ProjectId;
  revision: number;
  updatedAt: Date;
};

export interface WorkingSetRepository {
  get(userId: UserId, projectId: ProjectId): Promise<WorkingSetRow | null>;
  upsert(
    userId: UserId,
    projectId: ProjectId,
    snapshot: WorkingSetSnapshot,
  ): Promise<{ revision: number }>;
}
