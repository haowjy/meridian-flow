/**
 * ChatScreen — project workspace destination that renders the selected thread
 * as the primary pane. It coordinates desktop/mobile rail visibility without
 * owning thread routing itself.
 */
import { Trans } from "@lingui/react/macro";
import { useEffect } from "react";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { useThreadSnapshotSync } from "@/client/query/useThreadSnapshotSync";
import { useThreadStore } from "@/client/stores";
import { QueryErrorRow } from "@/components/app/QueryErrorRow";
import { ChatView } from "@/features/chat/ChatView";
import type { ChatPlacement } from "./ChatSurface";
import { resolveChatThreadId } from "./chat-thread-resolution";
import { SubagentBanner } from "./SubagentBanner";
import { SubagentTaskCard } from "./SubagentTaskCard";

export type ChatScreenProps = {
  projectId: string;
  /** Explicit `?thread=` from the route. Null = resolve via fallback chain. */
  threadId: string | null;
  /** Called when the user clicks the parent breadcrumb in a subagent banner. */
  onSelectThread: (threadId: string) => void;
  /**
   * Whether this instance may write its resolved fallback thread into the route
   * (`?thread=`). Only the destination-owning chat (centered) should — a
   * persistent dock on Home/Context must NOT, or it would hijack navigation and
   * redirect every destination to Chat. Defaults to true.
   */
  writeThreadToRoute?: boolean;
  placement?: ChatPlacement;
};

/**
 * Renders the thread conversation. When the thread is a subagent, prepends a
 * context banner that links back to the parent. Otherwise renders the chat as-is.
 *
 * The thread-id resolution chain mirrors the previous adapter:
 *   1. Pending-stream deferred-send map (synchronous on optimistic create).
 *   2. React Query thread-list cache.
 *   3. Server `listProjectThreads` fallback.
 */
export function ChatScreen({
  projectId,
  threadId: explicitThreadId,
  onSelectThread,
  writeThreadToRoute = true,
  placement = "center",
}: ChatScreenProps) {
  const pendingThreadId = useThreadStore((state) => {
    for (const [tid, ps] of Object.entries(state.pendingStreamByThreadId)) {
      if (ps.deferredSend?.projectId === projectId) return tid;
    }
    return null;
  });

  const { threads: projectThreads, isError, refetch } = useProjectThreads(projectId);

  const resolvedThreadId = resolveChatThreadId({
    explicitThreadId,
    pendingThreadId,
    projectThreads,
  });

  useEffect(() => {
    if (!writeThreadToRoute || explicitThreadId || !resolvedThreadId) return;
    onSelectThread(resolvedThreadId);
  }, [writeThreadToRoute, explicitThreadId, onSelectThread, resolvedThreadId]);

  if (resolvedThreadId === null) {
    if (isError) {
      return (
        <div className="px-4 py-3">
          <QueryErrorRow onRetry={refetch} />
        </div>
      );
    }
    if (projectThreads !== null && projectThreads.length === 0) {
      return (
        <div className="grid h-full place-items-center px-6 text-sm text-muted-foreground">
          <Trans>This project has no conversations yet.</Trans>
        </div>
      );
    }
    return null;
  }

  return (
    <ChatScreenLoaded
      projectId={projectId}
      threadId={resolvedThreadId}
      onSelectThread={onSelectThread}
      placement={placement}
    />
  );
}

function ChatScreenLoaded({
  projectId,
  threadId,
  onSelectThread,
  placement,
}: {
  projectId: string;
  threadId: string;
  onSelectThread: (threadId: string) => void;
  placement: ChatPlacement;
}) {
  const {
    thread: snapshotThread,
    liveState: snapshotLiveState,
    nextSeq: snapshotNextSeq,
    isError,
    refetch,
  } = useThreadSnapshotSync(threadId);
  const { threads: projectThreads } = useProjectThreads(projectId);
  const allThreads = projectThreads ?? [];
  const thread = allThreads.find((t) => t.id === threadId) ?? snapshotThread;
  const parent = thread?.parentThreadId
    ? (allThreads.find((t) => t.id === thread.parentThreadId) ?? null)
    : null;

  const isSubagent = thread?.kind === "subagent";

  return (
    <div className="flex h-full min-h-0 flex-col">
      {isSubagent && thread ? (
        <>
          <SubagentBanner subagent={thread} parent={parent} onOpenParent={onSelectThread} />
          <SubagentTaskCard subagent={thread} />
        </>
      ) : null}

      {isError ? (
        <div className="border-b border-destructive/30 bg-card px-4 py-2">
          <div className="mx-auto max-w-3xl">
            <QueryErrorRow onRetry={refetch} />
          </div>
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        <ChatView
          threadId={threadId}
          projectId={projectId}
          activeThread={thread}
          snapshotLiveState={snapshotLiveState}
          snapshotNextSeq={snapshotNextSeq}
          placement={placement}
          key={`${projectId}:${threadId}`}
        />
      </div>
    </div>
  );
}
