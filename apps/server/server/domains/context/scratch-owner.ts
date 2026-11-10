/** One rule for a chat's Scratch, shared by context dispatch and file policy. */
import { chatOwner } from "../../shared/draft-owner.js";
export type ScratchOwner =
  | { scope: "work"; workId: string }
  | { scope: "lineage"; projectId: string; rootThreadId: string };

export function scratchOwnerFor(
  thread: { id: string; projectId: string; rootThreadId: string },
  work: { id: string; isNoWork: boolean },
): ScratchOwner {
  const owner = chatOwner(thread, work);
  return owner.kind === "lineage"
    ? { scope: "lineage", projectId: owner.projectId, rootThreadId: owner.rootThreadId }
    : { scope: "work", workId: owner.workId };
}

export interface ScratchLineage {
  projectId: string;
  rootThreadId: string;
  rootThreadRef: string;
  title?: string | null;
}
export interface ScratchLineages {
  byId(projectId: string, rootThreadId: string): Promise<ScratchLineage | null>;
  byRef(projectId: string, ref: string): Promise<ScratchLineage | null>;
  rootForThreadRef(projectId: string, ref: string): Promise<ScratchLineage | null>;
  list(projectId: string): Promise<ScratchLineage[]>;
}
