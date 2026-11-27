export { type AiWriteMode, aiWriteModeSchema, effectiveAiWriteMode } from "./ai-write-mode.js";

import { z } from "zod";
import { decodeWorkHandle, type WorkHandle } from "../handles.js";
import type { DraftId, ProjectId, ThreadId, UserId, WorkId } from "../ids.js";
import type { AiWriteMode } from "./ai-write-mode.js";
import type { WorkReceiptState } from "./receipts.js";

export interface Work {
  id: WorkId;
  projectId: ProjectId;
  createdByUserId: UserId;
  name: string;
  handle: WorkHandle | null;
  isNoWork: boolean;
  draftId: DraftId | null;
  goal: string | null;
  status: string | null;
  archivedAt: string | null;
  defaultAiWriteMode: AiWriteMode;
  entityRevision: string;
  pendingDocumentCount: number;
  pendingFolderCount: number;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  deletedAt: string | null;
}

export type WorkLifecycleState = "active" | "archived" | "deleted";

export function workLifecycleState(work: {
  archivedAt: string | Date | null;
  deletedAt: string | Date | null;
}): WorkLifecycleState {
  if (work.deletedAt !== null) return "deleted";
  return work.archivedAt !== null ? "archived" : "active";
}

export function isWorkArchived(work: Pick<Work, "archivedAt">): boolean {
  return work.archivedAt !== null;
}

export type NamedWorkCatalogEntry = Work & { isNoWork: false; handle: WorkHandle };
export type NoWorkCatalogEntry = Work & { isNoWork: true; handle: null };

export type WorksSnapshot = {
  projectId: ProjectId;
  authorityRevision: string;
  requestId: string;
  works: readonly NamedWorkCatalogEntry[];
  noWork: NoWorkCatalogEntry;
};

const workHandleSchema = z
  .string()
  .refine((value) => decodeWorkHandle(value) !== null)
  .transform((value) => value as WorkHandle);

export const workSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  createdByUserId: z.string().min(1),
  name: z.string(),
  handle: workHandleSchema.nullable(),
  isNoWork: z.boolean(),
  draftId: z.string().nullable(),
  goal: z.string().nullable(),
  status: z.string().nullable(),
  archivedAt: z.string().nullable(),
  defaultAiWriteMode: z.enum(["draft", "direct"]),
  entityRevision: z.string().regex(/^(0|[1-9]\d*)$/),
  pendingDocumentCount: z.number().int().nonnegative(),
  pendingFolderCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastActivityAt: z.string(),
  deletedAt: z.string().nullable(),
}) satisfies z.ZodType<Work>;

export const workAnswerSchema = workSchema.extend({
  settled: z
    .array(
      z.discriminatedUnion("rule", [
        z.object({ rule: z.literal("already"), state: z.string() }),
        z.object({
          rule: z.literal("returned"),
          why: z.enum(["work_archived", "work_deleted"]),
        }),
      ]),
    )
    .optional(),
});

export type WorkAnswer = z.infer<typeof workAnswerSchema>;

export const worksSnapshotSchema = z.object({
  projectId: z.string().min(1),
  authorityRevision: z.string().regex(/^(0|[1-9]\d*)$/),
  requestId: z.string().min(1),
  works: z.array(workSchema.extend({ isNoWork: z.literal(false), handle: workHandleSchema })),
  noWork: workSchema.extend({ isNoWork: z.literal(true), handle: z.null() }),
}) satisfies z.ZodType<WorksSnapshot>;

export interface CreateWorkRequest {
  id?: WorkId;
  draftId?: DraftId;
  name: string;
  goal?: string;
}

export interface UpdateWorkRequest {
  name?: string;
  goal?: string;
}

export type ThreadWorkScope = { workId: WorkId; workHandle: WorkHandle | null };

export type ThreadExecutionContext = {
  scope: ThreadWorkScope;
  aiWriteMode: AiWriteMode;
  draftId: DraftId;
};

export interface RebindThreadWorkRequest {
  workId: WorkId | null;
}

export type RebindThreadWorkError =
  | { code: "thread_unavailable" }
  | { code: "target_work_unavailable"; workId: WorkId }
  | { code: "project_mismatch"; workId: WorkId };

export type WorkContextUpdateStatus = "delivered" | "pending" | "not_required";

export type WorkBindingState = WorkReceiptState & {
  workId: WorkId;
  handle: WorkHandle | null;
};

export interface RebindThreadWorkResult {
  threadId: ThreadId;
  before: WorkBindingState;
  after: WorkBindingState;
  changed: boolean;
}

export interface RebindThreadWorkResponse extends RebindThreadWorkResult {
  contextUpdate: WorkContextUpdateStatus;
}

export const WORK_CONTEXT_PROJECTION_EVENT = "meridian.work_context.changed" as const;

export interface WorkContextProjectionSignal {
  threadId: import("../ids.js").ThreadId;
  projectId: ProjectId;
  scope: ThreadWorkScope;
}

export { decodeWorkHandle, formatWorkHandle, type WorkHandle } from "../handles.js";
export * from "./metadata.js";
export * from "./receipts.js";
export * from "./work-authority.js";
