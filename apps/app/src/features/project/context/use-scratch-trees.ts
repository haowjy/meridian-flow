/** The Scratch trees on screen: the owner's own, and the lineage's notes a Work rebind left behind. */

import { t } from "@lingui/core/macro";
import { type ContextOwner, contextOwner } from "@meridian/contracts/protocol";
import { useMemo } from "react";
import { useProjectTreeView } from "@/client/query/useProjectTree";
import { useWorks } from "@/client/query/useWorks";
import { useTreeVersion } from "@/core/project-tree/tree-version";
import { useWorkScopeState } from "../use-work-scope";

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

/**
 * The picked Work's Scratch, the one the sidebar lists and the destination pickers offer: null
 * under None, whose chats keep their notes in their own Files menu. A Work still being created
 * has its Scratch already.
 */
export function useScopeScratchSource(projectId: string): ScratchSource | null {
  const { workId } = useWorkScopeState(projectId);
  const { works, deleted, creations, noWork } = useWorks(projectId);
  const named = workId && noWork && workId !== noWork.id ? workId : null;
  const name = named
    ? ((
        works?.find((candidate) => candidate.id === named) ??
        deleted.find((candidate) => candidate.id === named) ??
        creations.get(named)?.work
      )?.name ?? null)
    : null;
  return useMemo(
    () =>
      named
        ? { owner: { workId: named }, heading: name ? t`Scratch for ${name}` : t`Scratch` }
        : null,
    [named, name],
  );
}
