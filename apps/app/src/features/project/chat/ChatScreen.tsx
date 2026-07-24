/**
 * ChatScreen — project workspace destination that renders the selected thread
 * as the primary pane. It coordinates desktop/mobile rail visibility without
 * owning thread routing itself.
 */
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeScheme, Thread, Work } from "@meridian/contracts/protocol";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { useThreadSnapshotSync } from "@/client/query/useThreadSnapshotSync";
import { QueryErrorRow } from "@/components/app/QueryErrorRow";
import { ChatView } from "@/features/chat/ChatView";
import { ProjectChatContextNavigationProvider } from "./ProjectChatContextNavigationProvider";
import { SubagentBanner } from "./SubagentBanner";
import { SubagentTaskCard } from "./SubagentTaskCard";

export type ChatScreenProps = {
  projectId: string;
  /** ProjectView's resolved thread. */
  threadId: string | null;
  activeWork: Work | null;
  /** Called when the user clicks the parent breadcrumb in a subagent banner. */
  onSelectThread: (threadId: string) => void;
  onSelectContextPath?: (path: string, scheme?: ProjectContextTreeScheme) => void;
};

/** Renders the resolved thread, with parent context when it is a subagent. */
export function ChatScreen({
  projectId,
  threadId,
  activeWork,
  onSelectThread,
  onSelectContextPath,
}: ChatScreenProps) {
  const { threads: projectThreads, isError, refetch } = useProjectThreads(projectId);

  if (threadId === null) {
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
          <Trans>This project has no chats yet.</Trans>
        </div>
      );
    }
    return null;
  }

  return (
    <ChatScreenLoaded
      projectId={projectId}
      threadId={threadId}
      activeWork={activeWork}
      projectThreads={projectThreads ?? []}
      onSelectThread={onSelectThread}
      onSelectContextPath={onSelectContextPath}
    />
  );
}

function ChatScreenLoaded({
  projectId,
  threadId,
  activeWork,
  projectThreads,
  onSelectThread,
  onSelectContextPath,
}: {
  projectId: string;
  threadId: string;
  activeWork: Work | null;
  projectThreads: Thread[];
  onSelectThread: (threadId: string) => void;
  onSelectContextPath?: (path: string, scheme?: ProjectContextTreeScheme) => void;
}) {
  const {
    thread: snapshotThread,
    liveState: snapshotLiveState,
    nextSeq: snapshotNextSeq,
    isError,
    refetch,
  } = useThreadSnapshotSync(threadId);
  const thread = projectThreads.find((t) => t.id === threadId) ?? snapshotThread;
  const parent = thread?.parentThreadId
    ? (projectThreads.find((t) => t.id === thread.parentThreadId) ?? null)
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
        <ProjectChatContextNavigationProvider
          activeWorkId={activeWork?.id ?? null}
          onSelectContextPath={onSelectContextPath}
        >
          <ChatView
            threadId={threadId}
            projectId={projectId}
            activeThread={thread}
            activeWork={activeWork}
            snapshotLiveState={snapshotLiveState}
            snapshotNextSeq={snapshotNextSeq}
            key={`${projectId}:${threadId}`}
          />
        </ProjectChatContextNavigationProvider>
      </div>
    </div>
  );
}
