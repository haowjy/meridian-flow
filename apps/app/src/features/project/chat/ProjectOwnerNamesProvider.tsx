/**
 * Names the owners a chat's addresses carry by handle, from the project's Works and chats: a
 * Work by its name and, where another Work shares it, its handle (soft-deleted ones too, while restorable), a lineage by its first chat's
 * title, an upload's chat by its title.
 */
import type { ReactNode } from "react";
import { useCallback } from "react";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { useWorks } from "@/client/query/useWorks";
import type { OwnerNames } from "@/features/chat/document-display-name";
import { OwnerNamesProvider } from "@/features/chat/owner-names";
import { displayThreadTitle } from "@/lib/thread-title";

export function ProjectOwnerNamesProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const { works, deleted, nameOf } = useWorks(projectId);
  const { threads } = useProjectThreads(projectId);
  const names = useCallback<OwnerNames>(
    (owner) => {
      switch (owner.kind) {
        case "work":
        case "work-id": {
          const work = (works ?? [])
            .concat(deleted)
            .find((each) =>
              owner.kind === "work" ? each.handle === owner.workHandle : each.id === owner.workId,
            );
          return work ? nameOf(work) : null;
        }
        case "lineage": {
          const first = threads?.find(
            (thread) => thread.ref === owner.rootThreadRef && thread.rootThreadId === thread.id,
          );
          return first ? displayThreadTitle(first.title) : null;
        }
        case "chat": {
          const chat = threads?.find(
            (thread) => thread.ref === owner.chatRef && thread.kind !== "subagent",
          );
          return chat ? displayThreadTitle(chat.title) : null;
        }
      }
    },
    [works, deleted, nameOf, threads],
  );
  return <OwnerNamesProvider names={names}>{children}</OwnerNamesProvider>;
}
