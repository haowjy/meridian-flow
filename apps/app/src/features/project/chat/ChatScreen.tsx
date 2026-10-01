/**
 * ChatScreen — renders the resolved thread in whichever pane hosts the chat
 * (center, dock, phone), or the empty New chat when there is none. It never
 * owns thread routing itself; it reads `useChatNavigation()` for the commands
 * a chat surface needs (opening the parent of a subagent, focusing a freshly
 * requested New chat composer). A chat whose Work is archived keeps its live
 * composer, with the archived notice as a strip on the composer's top edge.
 */
import { t } from "@lingui/core/macro";
import type { Thread, Work } from "@meridian/contracts/protocol";
import { isWorkArchived } from "@meridian/contracts/works";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { useThreadSnapshotSync } from "@/client/query/useThreadSnapshotSync";
import { QueryErrorRow } from "@/components/app/QueryErrorRow";
import { ChatSurface as ChatFrame } from "@/features/chat/ChatSurface";
import { ChatView } from "@/features/chat/ChatView";
import { CreationComposer } from "@/features/chat/CreationComposer";
import { useThreadActivity } from "@/features/chat/useThreadActivity";
import { useChatNavigation } from "../routing/chat-navigation";
import type { ContextRouteTarget } from "../routing/project-route";
import { ArchivedWorkNotice } from "../work/ArchivedWorkNotice";
import { ProjectChatContextNavigationProvider } from "./ProjectChatContextNavigationProvider";
import { SubagentPathRow } from "./SubagentPathRow";

export type ChatScreenProps = {
  projectId: string;
  /** ProjectView's resolved thread. */
  threadId: string | null;
  activeWork: Work | null;
  availableWorks: readonly Work[];
  onOpenContextTarget?: (target: ContextRouteTarget) => void;
  /** False while the host keeps the chat mounted but hidden. */
  visible?: boolean;
};

/** Renders the resolved thread, with parent context when it is a subagent. */
export function ChatScreen({
  projectId,
  threadId,
  activeWork,
  availableWorks,
  onOpenContextTarget,
  visible = true,
}: ChatScreenProps) {
  const { threads: projectThreads } = useProjectThreads(projectId);
  const { openChat, newChatFocusRequestId, newChatWorkId, consumeNewChatFocusRequest } =
    useChatNavigation();

  // New chat: the same frame a live chat uses, with nothing above the composer
  // yet, so the first Send grows a transcript without moving the composer.
  if (threadId === null) {
    return (
      <ChatFrame
        title={t`New chat`}
        footer={
          <CreationComposer
            projectId={projectId}
            newChatFocusRequestId={newChatFocusRequestId}
            newChatWorkId={newChatWorkId}
            onNewChatFocusHandled={consumeNewChatFocusRequest}
          />
        }
      >
        {null}
      </ChatFrame>
    );
  }

  return (
    <ChatScreenLoaded
      projectId={projectId}
      threadId={threadId}
      activeWork={activeWork}
      availableWorks={availableWorks}
      projectThreads={projectThreads ?? []}
      onSelectThread={openChat}
      onOpenContextTarget={onOpenContextTarget}
      visible={visible}
    />
  );
}

function ChatScreenLoaded({
  projectId,
  threadId,
  activeWork,
  availableWorks,
  projectThreads,
  onSelectThread,
  onOpenContextTarget,
  visible,
}: {
  projectId: string;
  threadId: string;
  activeWork: Work | null;
  availableWorks: readonly Work[];
  projectThreads: Thread[];
  onSelectThread: (threadId: string) => void;
  onOpenContextTarget?: (target: ContextRouteTarget) => void;
  visible: boolean;
}) {
  const {
    activateProjection,
    thread: snapshotThread,
    liveState: snapshotLiveState,
    nextSeq: snapshotNextSeq,
    snapshot,
    isError,
    settled: historySettled,
    refetch,
  } = useThreadSnapshotSync(threadId);
  const thread = projectThreads.find((t) => t.id === threadId) ?? snapshotThread;
  const ancestors = snapshot?.ancestors ?? [];
  const activity = useThreadActivity({
    threadId: thread?.rootThreadId ?? threadId,
    rootThreadId: thread?.rootThreadId ?? threadId,
    seed: null,
  });
  const currentRun = activity.activity.descendants.find((node) => node.threadId === threadId);

  const isSubagent = thread?.kind === "subagent";

  return (
    <div className="flex h-full min-h-0 flex-col">
      {isSubagent && thread ? (
        <SubagentPathRow
          subagent={thread}
          ancestors={ancestors}
          runStatus={
            thread.spawnStatus ?? (snapshotLiveState?.status.kind === "awake" ? "running" : null)
          }
          startedAt={currentRun?.runStartedAt}
          endedAt={currentRun?.runEndedAt}
          onOpenParent={onSelectThread}
        />
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
          projectId={projectId}
          activeWork={activeWork?.slug ? { id: activeWork.id, slug: activeWork.slug } : null}
          availableWorks={availableWorks.flatMap((work) =>
            work.slug ? [{ id: work.id, slug: work.slug }] : [],
          )}
          onOpenContextTarget={onOpenContextTarget}
        >
          <ChatView
            threadId={threadId}
            projectId={projectId}
            activeThread={thread}
            activeWork={activeWork}
            snapshotLiveState={snapshotLiveState}
            snapshotNextSeq={snapshotNextSeq}
            snapshotThreadUsage={snapshot?.threadUsage}
            historySettled={historySettled}
            activateProjection={activateProjection}
            active={visible}
            composerStrip={
              activeWork && isWorkArchived(activeWork) ? (
                <ArchivedWorkNotice projectId={projectId} work={activeWork} variant="strip" />
              ) : undefined
            }
            key={`${projectId}:${threadId}`}
          />
        </ProjectChatContextNavigationProvider>
      </div>
    </div>
  );
}
