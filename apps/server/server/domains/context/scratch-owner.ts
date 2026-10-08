/** One rule for a chat's Scratch, shared by context dispatch and file policy. */
export type ScratchOwner =
  | { scope: "work"; workId: string }
  | { scope: "lineage"; projectId: string; rootThreadId: string };

export function scratchOwnerFor(
  thread: { id: string; projectId: string; rootThreadId: string },
  work: { id: string; isNoWork: boolean },
): ScratchOwner {
  return work.isNoWork
    ? { scope: "lineage", projectId: thread.projectId, rootThreadId: thread.rootThreadId }
    : { scope: "work", workId: work.id };
}

export interface ScratchLineage {
  projectId: string;
  rootThreadId: string;
  rootThreadRef: string;
}
export interface ScratchLineages {
  byId(projectId: string, rootThreadId: string): Promise<ScratchLineage | null>;
  byRef(projectId: string, ref: string): Promise<ScratchLineage | null>;
  rootForThreadRef(projectId: string, ref: string): Promise<ScratchLineage | null>;
  list(projectId: string): Promise<ScratchLineage[]>;
}
