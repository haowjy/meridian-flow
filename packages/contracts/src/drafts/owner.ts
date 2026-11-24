import type { ProjectId, ThreadId, WorkId } from "../ids.js";

export type DraftOwner =
  | { kind: "work"; workId: WorkId }
  | { kind: "lineage"; projectId: ProjectId; rootThreadId: ThreadId };
