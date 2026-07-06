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
  /**
   * S4-WIRE: the server's count of unpushed `branch_write_journal` rows across
   * this work's branches (spec §3.4) — the single denominator the whole review
   * surface trusts. The confirm-and-push popover renders this exact N ("Apply N
   * and switch") and the server pushes exactly this many, so the copy cannot
   * lie. MUST come from the server, never recomputed from visible dock rows.
   * Produced by the S4 server lane; `null`/absent until it lands.
   */
  unpushedChangeCount?: number | null;
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
