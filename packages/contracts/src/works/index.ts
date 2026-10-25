export { type AiWriteMode, aiWriteModeSchema, effectiveAiWriteMode } from "./ai-write-mode.js";

import type { WorkHandle } from "../handles.js";
import type { ProjectId, ThreadId, UserId, WorkId } from "../ids.js";
import type { AiWriteMode } from "./ai-write-mode.js";
import type { WorkReceiptState } from "./receipts.js";

export interface Work {
  id: WorkId;
  projectId: ProjectId;
  createdByUserId: UserId;
  name: string;
  /** Permanent project-unique handle (`w3`), never reused. Null on the locked No Work row. */
  handle: WorkHandle | null;
  isNoWork: boolean;
  goal: string | null;
  /** AI-owned one-to-three-word progress summary. */
  status: string | null;
  archivedAt: string | null;
  /** What a new chat in this Work starts with. A chat owns its own mode afterwards. */
  defaultAiWriteMode: AiWriteMode;
  /** Durable per-entity ordering fence. JSON form of a monotonic bigint. */
  entityRevision: string;
  /** Documents this Work's active branch changes (the Works badge), as the server stores it; never derive from visible rows. */
  pendingDocumentCount: number;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  deletedAt: string | null;
}

/** Where a Work stands in its lifecycle. Deleted wins over archived. */
export type WorkLifecycleState = "active" | "archived" | "deleted";

export function workLifecycleState(
  work: Pick<Work, "archivedAt" | "deletedAt">,
): WorkLifecycleState {
  if (work.deletedAt !== null) return "deleted";
  return work.archivedAt !== null ? "archived" : "active";
}

/** The one archived test. An archived Work's own content is read-only; its chats still accept messages. */
export function isWorkArchived(work: Pick<Work, "archivedAt">): boolean {
  return work.archivedAt !== null;
}

export type NamedWorkCatalogEntry = Work & { isNoWork: false; handle: WorkHandle };
export type NoWorkCatalogEntry = Work & { isNoWork: true; handle: null };

/** Complete, version-ordered Work lifecycle projection for one project. */
export type WorksSnapshot = {
  projectId: ProjectId;
  /** Causal project-catalog evidence; clients do not use it for snapshot ordering. */
  catalogGeneration: string;
  /** Project availability generation: the total order for complete snapshots. */
  authorityRevision: string;
  /** Correlates one acquisition response; it is not ordering authority. */
  requestId: string;
  works: readonly NamedWorkCatalogEntry[];
  noWork: NoWorkCatalogEntry;
};

export interface CreateWorkRequest {
  id?: WorkId;
  name: string;
  goal?: string;
}

export interface UpdateWorkRequest {
  name?: string;
  goal?: string;
}

/** Resolved execution scope. Null handle is No Work. */
export type ThreadWorkScope = { workId: WorkId; workHandle: WorkHandle | null };

/** Resolved execution always has a Work id. Null handle is No Work. */
export type ThreadExecutionContext = {
  scope: ThreadWorkScope;
  aiWriteMode: AiWriteMode;
  branchOwner: { kind: "work"; workId: WorkId } | null;
};

/** HTTP rebind body. Null workId falls back to the project's No Work row. */
export interface RebindThreadWorkRequest {
  workId: WorkId | null;
}

export type RebindThreadWorkError =
  | { code: "thread_unavailable" }
  | { code: "target_work_unavailable"; workId: WorkId }
  | { code: "project_mismatch"; workId: WorkId };

export type WorkContextUpdateStatus = "delivered" | "pending" | "not_required";

/** One side of a thread's Work rebind. */
export type WorkBindingState = WorkReceiptState & {
  workId: WorkId;
  handle: WorkHandle | null;
};

/** Authoritative result shared by writer and model Work-rebind adapters. */
export interface RebindThreadWorkResult {
  threadId: ThreadId;
  before: WorkBindingState;
  after: WorkBindingState;
  changed: boolean;
}

export interface RebindThreadWorkResponse extends RebindThreadWorkResult {
  contextUpdate: WorkContextUpdateStatus;
}

/** Live AG-UI projection emitted after a durable Work-context update commits. */
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
