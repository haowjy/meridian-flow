/**
 * ProjectChatContextNavigationProvider — adapts chat-local document URI opens
 * to the project route's context-file selection contract.
 *
 * Every door routes the same way, and every door tells passage navigation it
 * happened — carrying an anchor when the row had one. That second call is not
 * an extra for passage rows: it is where navigation ownership changes hands,
 * so an ordinary door retires whatever a search row was still resolving. It
 * never gates the route change, so a search row whose passage has moved still
 * opens its document.
 */
import { type ReactNode, useCallback, useMemo } from "react";
import { useLineage } from "@/client/query/useLineageTitle";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { useWorks } from "@/client/query/useWorks";

import {
  ChatContextNavigationProvider,
  type ContextPassageAnchor,
} from "@/features/chat/ChatContextNavigation";
import {
  type ChatLineages,
  contextRouteTargetFromUri,
  canOpenContextUri as isContextUriRoutable,
} from "@/lib/context-uri";
import type { ContextRouteRequest } from "../routing/project-route";
import { usePassageDoors } from "./usePassageDoors";

type OpenContextTarget = (target: ContextRouteRequest) => void;

export function ProjectChatContextNavigationProvider({
  projectId,
  activeWork,
  availableWorks,
  rootThreadId,
  onOpenContextTarget,
  children,
}: {
  projectId: string;
  activeWork: { id: string; slug: string | null } | null;
  availableWorks: readonly { id: string; slug: string | null }[];
  /** The displayed chat's lineage: where its bare `scratch://` points while it is on No Work. */
  rootThreadId: string | null;
  onOpenContextTarget?: OpenContextTarget;
  children: ReactNode;
}) {
  const { noWork } = useWorks(projectId);
  const noWorkId = noWork?.id;
  const { threads } = useProjectThreads(projectId);
  // The chat's own lineage answers to its handle even after its first chat is
  // trashed (a fork keeps the notes); the live list is only for other chats.
  const ownHandle = useLineage(projectId, rootThreadId ? { rootThreadId } : null)?.rootThreadRef;
  const lineages = useMemo<ChatLineages>(
    () => ({
      own: rootThreadId,
      idForRef: (ref) =>
        ref === ownHandle
          ? rootThreadId
          : // A handle names the first chat, so it is that chat's own id.
            (threads?.find((thread) => thread.ref === ref && thread.rootThreadId === thread.id)
              ?.id ?? null),
    }),
    [ownHandle, rootThreadId, threads],
  );
  const doorOpened = usePassageDoors(projectId, activeWork?.id ?? null);
  const openContextUri = useCallback(
    (uri: string, passage?: ContextPassageAnchor) => {
      if (!onOpenContextTarget || !activeWork || !noWorkId) return;
      const target = contextRouteTargetFromUri(uri, activeWork, availableWorks, noWorkId, lineages);
      if (!target) return;
      onOpenContextTarget({ ...target, workId: target.workId ?? undefined });
      doorOpened({ ...target, uri }, passage);
    },
    [activeWork, availableWorks, noWorkId, lineages, doorOpened, onOpenContextTarget],
  );
  const canOpenContextUri = useCallback(
    (uri: string) =>
      !!activeWork &&
      !!noWorkId &&
      isContextUriRoutable(uri, activeWork, availableWorks, noWorkId, lineages),
    [activeWork, availableWorks, noWorkId, lineages],
  );

  return (
    <ChatContextNavigationProvider
      onOpenContextUri={onOpenContextTarget ? openContextUri : null}
      canOpenContextUri={onOpenContextTarget ? canOpenContextUri : null}
    >
      {children}
    </ChatContextNavigationProvider>
  );
}
