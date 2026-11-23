/**
 * Whose material a chat writes: its named Work, or its conversation lineage (a chat with no Work,
 * its forks and subagents). Scratch is the owner's. A Work owns its drafts (`drafts.work_id`); a
 * lineage's one draft is the one its root chat names (`threads.draft_id`) with no Work.
 */
import type { ProjectId, ThreadId, WorkId } from "../ids.js";

export type DraftOwner =
  | { kind: "work"; workId: WorkId }
  | { kind: "lineage"; projectId: ProjectId; rootThreadId: ThreadId };
