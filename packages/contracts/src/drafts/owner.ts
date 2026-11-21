/**
 * Whose material a chat writes: its named Work, or its conversation lineage (a chat with no Work,
 * its forks and subagents). Scratch is the owner's, and the owner names the draft its chats
 * draft into (`works.draft_id`, the root chat's `threads.draft_id`); the draft names no owner.
 */
import type { ProjectId, ThreadId, WorkId } from "../ids.js";

export type DraftOwner =
  | { kind: "work"; workId: WorkId }
  | { kind: "lineage"; projectId: ProjectId; rootThreadId: ThreadId };
