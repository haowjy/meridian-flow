/**
 * ChatScreen — renders the resolved thread in whichever pane hosts the chat
 * (center, dock, phone), or the empty New chat when there is none. It never
 * owns thread routing itself; it reads `useChatNavigation()` for the commands
 * a chat surface needs (opening the parent of a subagent, focusing a freshly
 * requested New chat composer).
 */
import { t } from "@lingui/core/macro";
import type { Thread, Work } from "@meridian/contracts/protocol";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { useThreadSnapshotSync } from "@/client/query/useThreadSnapshotSync";
import { QueryErrorRow } from "@/components/app/QueryErrorRow";
import { ChatSurface as ChatFrame } from "@/features/chat/ChatSurface";
import { ChatThreadNavigationProvider } from "@/features/chat/ChatThreadNavigation";
import { ChatView } from "@/features/chat/ChatView";
import { CreationComposer } from "@/features/chat/CreationComposer";
import { useChatNavigation } from "../routing/chat-navigation";
import type { ContextRouteTarget } from "../routing/project-route";
import { ProjectChatContextNavigationProvider } from "./ProjectChatContextNavigationProvider";
import { SubagentBanner } from "./SubagentBanner";
import { SubagentTaskCard } from "./SubagentTaskCard";

export type ChatScreenProps = {
  projectId: string;
  /** ProjectView's resolved thread. */
  threadId: string | null;
  activeWork: Work | null;
  availableWorks: readonly Work[];
  onOpenContextTarget?: (target: ContextRouteTarget) => void;
};

/** Renders the resolved thread, with parent context when it is a subagent. */
export function ChatScreen({
  projectId,
  threadId,
  activeWork,
  availableWorks,
  onOpenContextTarget,
}: ChatScreenProps) {
  const { threads: projectThreads } = useProjectThreads(projectId);
  const { openChat, newChatFocusRequestId, consumeNewChatFocusRequest } = useChatNavigation();

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
}: {
  projectId: string;
  threadId: string;
  activeWork: Work | null;
  availableWorks: readonly Work[];
  projectThreads: Thread[];
  onSelectThread: (threadId: string) => void;
  onOpenContextTarget?: (target: ContextRouteTarget) => void;
}) {
  const {
    snapshot,
    activateProjection,
    thread: snapshotThread,
    liveState: snapshotLiveState,
    nextSeq: snapshotNextSeq,
    isError,
    settled: historySettled,
    refetch,
  } = useThreadSnapshotSync(threadId);
  const thread = projectThreads.find((t) => t.id === threadId) ?? snapshotThread;
  const parent = snapshot?.parent ?? null;

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
        <ChatThreadNavigationProvider onOpenThread={onSelectThread}>
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
              historySettled={historySettled}
              activateProjection={activateProjection}
              key={`${projectId}:${threadId}`}
            />
          </ProjectChatContextNavigationProvider>
        </ChatThreadNavigationProvider>
      </div>
    </div>
  );
}
