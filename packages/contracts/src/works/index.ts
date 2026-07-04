import type { WorkVisibility } from "../enums.js";

export type AiWriteMode = "direct" | "draft";

export const AI_WRITE_MODE_VALUES: readonly AiWriteMode[] = ["direct", "draft"];

import type { ProjectId, UserId, WorkId } from "../ids.js";

export interface Work {
  id: WorkId;
  projectId: ProjectId;
  createdByUserId: UserId;
  title: string;
  visibility: WorkVisibility;
  aiWriteMode: AiWriteMode;
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
