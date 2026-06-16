import type { WorkVisibility } from "../enums.js";
import type { ProjectId, UserId, WorkId } from "../ids.js";

export interface Work {
  id: WorkId;
  projectId: ProjectId;
  createdByUserId: UserId;
  title: string;
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
