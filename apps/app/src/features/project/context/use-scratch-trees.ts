/** The Scratch trees on screen: the owner's own, and the lineage's notes a Work rebind left behind. */

import { type ContextOwner, contextOwner } from "@meridian/contracts/protocol";
import { useProjectTreeView } from "@/client/query/useProjectTree";
import { useTreeVersion } from "@/core/project-tree/tree-version";

export type ScratchSource = {
  owner: ContextOwner;
  heading: string;
  earlierRootThreadId?: string | null;
};

/** Read in the shell's version, the one their actions write. */
export function useScratchTrees(projectId: string, source: ScratchSource | null) {
  const version = useTreeVersion();
  const primary = useProjectTreeView(projectId, "scratch", {
    workId: source?.owner.workId,
    rootThreadId: source?.owner.rootThreadId,
    enabled: source !== null,
    version,
  });
  const earlier = useProjectTreeView(projectId, "scratch", {
    ...contextOwner(null, source?.earlierRootThreadId),
    enabled: Boolean(source?.earlierRootThreadId),
    version,
  });
  return { primary, earlier };
}
