// @ts-nocheck
/**
 * IndependentChatView — standalone chat route for a thread outside the full
 * workbench workspace chrome, with promotion back into a workbench when needed.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, FolderPlus } from "lucide-react";
import { useCallback } from "react";

import { useThreadSnapshotSync } from "@/client/query/useThreadSnapshotSync";
import { promoteIndependentWorkbench } from "@/client/stores";
import { ChatView } from "@/features/chat/ChatView";

/**
 * Independent chat surface (`/chat/:threadId`) — a thread the user experiences
 * as workbench-less. Minimal chrome: no Rail, no panels. A back button returns to
 * home; "Create workbench" promotes the hidden workbench backing this chat and
 * routes into the full workspace.
 */
export type IndependentChatViewProps = {
  threadId: string;
};

export function IndependentChatView({ threadId }: IndependentChatViewProps) {
  const navigate = useNavigate();
  const {
    thread,
    liveState: snapshotLiveState,
    nextSeq: snapshotNextSeq,
  } = useThreadSnapshotSync(threadId);
  const workbenchId = thread?.workbenchId ?? null;

  const handlePromote = useCallback(() => {
    if (!workbenchId) return;
    promoteIndependentWorkbench(workbenchId);
    void navigate({ to: "/workbench/$workbenchId", params: { workbenchId } });
  }, [navigate, workbenchId]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background text-foreground">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-3">
        <button
          type="button"
          aria-label={t`Back to home`}
          onClick={() => void navigate({ to: "/" })}
          className="focus-ring grid size-8 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden />
        </button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {thread?.title?.trim() || <Trans>New chat</Trans>}
        </span>
        <button
          type="button"
          onClick={handlePromote}
          disabled={!workbenchId}
          className="focus-ring inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground disabled:opacity-50"
        >
          <FolderPlus className="size-3.5" aria-hidden />
          <Trans>Create workbench</Trans>
        </button>
      </header>

      <main className="min-h-0 flex-1">
        <ChatView
          threadId={threadId}
          workbenchId={workbenchId}
          activeThread={thread}
          snapshotLiveState={snapshotLiveState}
          snapshotNextSeq={snapshotNextSeq}
          key={threadId}
        />
      </main>
    </div>
  );
}
