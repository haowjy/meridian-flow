import { t } from "@lingui/core/macro";
import { useMemo } from "react";
import { useDisplayedThread } from "@/client/query/useDisplayedThread";
import { useWorks } from "@/client/query/useWorks";
import { workFromSnapshot } from "@/client/query/works-projection-acquisition";
import { chatScratchOwner } from "@/features/chat/chat-scratch-owner";
import type { ScratchSource } from "../context/use-scratch-trees";
import { useOptionalChatOnScreen } from "../side/SideView";

export function useChatScratchSource(
  projectId: string,
  threadId: string | null,
): ScratchSource | null {
  const { works, noWork, nameOf } = useWorks(projectId);
  const thread = useDisplayedThread(projectId, threadId);
  const work =
    thread?.workId && noWork
      ? workFromSnapshot({ works: works ?? [], noWork }, thread.workId)
      : null;
  const owner = chatScratchOwner({ thread, work });
  const rootThreadId = owner?.kind === "lineage" ? owner.rootThreadId : null;
  const workId = owner?.kind === "work" ? owner.workId : null;
  const earlierRootThreadId = owner?.kind === "work" ? (thread?.rootThreadId ?? null) : null;
  const workName = owner?.kind === "work" && work ? nameOf(work) : undefined;
  return useMemo(() => {
    if (!owner || !thread) return null;
    return {
      owner: rootThreadId !== null ? { rootThreadId } : { workId },
      earlierRootThreadId,
      heading: workName
        ? t`Scratch for ${workName}`
        : rootThreadId !== null
          ? t`Scratch for this chat`
          : t`Scratch`,
    };
  }, [Boolean(owner), Boolean(thread), rootThreadId, workId, earlierRootThreadId, workName]);
}

export function useOnScreenChatScratchSource(projectId: string): ScratchSource | null {
  return useChatScratchSource(projectId, useOptionalChatOnScreen());
}
