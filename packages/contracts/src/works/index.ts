import type { WorkVisibility } from "../enums.js";
import type { ProjectId, UserId, WorkId } from "../ids.js";

export type WorkStatus = "active" | "archived";

export interface Work {
  id: WorkId;
  projectId: ProjectId;
  createdByUserId: UserId;
  title: string;
  description: string | null;
  status: WorkStatus;
  visibility: WorkVisibility;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  deletedAt: string | null;
}

export interface CreateWorkRequest {
  id?: WorkId;
  title?: string;
  visibility?: WorkVisibility;
}
