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
 * The picked Work's Scratch, as the sidebar lists it: null under None, whose chats keep their
 * notes in their own Files menu.
 */
export function useScopeScratchSource(projectId: string): ScratchSource | null {
  const { workId } = useWorkScopeState(projectId);
  const { works, deleted, noWork } = useWorks(projectId);
  const work =
    workId && workId !== noWork?.id
      ? (works?.find((candidate) => candidate.id === workId) ??
        deleted.find((candidate) => candidate.id === workId))
      : undefined;
  const name = work?.name;
  return useMemo(
    () => (workId && name ? { owner: { workId }, heading: t`Scratch for ${name}` } : null),
    [workId, name],
  );
}
