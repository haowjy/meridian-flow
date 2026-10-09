/**
 * The Scratch a chat has on screen, as the rail's section and the dock
 * document's menu both read it: the lineage's for a No Work chat, the Work's
 * for a chat on a named Work (with the lineage left behind by a rebind kept
 * findable), named "Scratch for this chat" or "Scratch for <Work>". Null while
 * the chat is unknown, so the callers show nothing rather than guess.
 */
import { t } from "@lingui/core/macro";
import { useMemo } from "react";
import { useDisplayedThread } from "@/client/query/useDisplayedThread";
import { useWorks } from "@/client/query/useWorks";
import { workFromSnapshot } from "@/client/query/works-projection-acquisition";
import { chatScratchOwner } from "@/features/chat/chat-scratch-owner";
import type { ScratchSource } from "../context/use-catalog-menu-source";

export function useChatScratchSource(
  projectId: string,
  threadId: string | null,
): ScratchSource | null {
  const { works, noWork } = useWorks(projectId);
  const thread = useDisplayedThread(projectId, threadId);
  const work =
    thread?.workId && noWork
      ? workFromSnapshot({ works: works ?? [], noWork }, thread.workId)
      : null;
  const owner = chatScratchOwner({ thread, work });
  const rootThreadId = owner?.kind === "lineage" ? owner.rootThreadId : null;
  const workId = owner?.kind === "work" ? owner.workId : null;
  const earlierRootThreadId = owner?.kind === "work" ? (thread?.rootThreadId ?? null) : null;
  const workName = owner?.kind === "work" ? work?.name : undefined;
  return useMemo(() => {
    if (!owner || !thread) return null;
    return {
      owner: rootThreadId !== null ? { rootThreadId } : { workId },
      // A chat rebound onto a Work keeps its lineage's notes findable.
      earlierRootThreadId,
      // The rail always means the chat on screen, so a chat's own notes need no name.
      heading: workName
        ? t`Scratch for ${workName}`
        : rootThreadId !== null
          ? t`Scratch for this chat`
          : t`Scratch`,
    };
  }, [Boolean(owner), Boolean(thread), rootThreadId, workId, earlierRootThreadId, workName]);
}
