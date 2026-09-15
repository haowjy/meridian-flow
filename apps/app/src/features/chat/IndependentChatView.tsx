/**
 * IndependentChatView — standalone chat route for a thread outside the full
 * project workspace chrome, with promotion back into a project when needed.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, FolderPlus } from "lucide-react";
import { useCallback } from "react";
import { getProject } from "@/client/api/projects-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { useThreadSnapshotSync } from "@/client/query/useThreadSnapshotSync";
import { useWorks } from "@/client/query/useWorks";
import { promoteIndependentProject } from "@/client/stores";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { ChatView } from "@/features/chat/ChatView";
import { DraftReviewProvider } from "@/features/chat/DraftReviewProvider";

/**
 * Independent chat surface (`/chat/:threadId`) — a thread the user experiences
 * as project-less. Minimal chrome: no Rail, no panels. A back button returns to
 * home; "Create project" promotes the hidden project backing this chat and
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
    settled: historySettled,
  } = useThreadSnapshotSync(threadId);
  const projectId = thread?.projectId ?? null;

  const project = useQuery({
    queryKey: projectQueryKeys.detail(projectId ?? ""),
    queryFn: () => getProject(projectId ?? ""),
    enabled: !!projectId,
  });

  const { works } = useWorks(projectId ?? "", { enabled: Boolean(projectId) });
  const activeWork = works?.find((work) => work.id === thread?.workId) ?? null;

  const handlePromote = useCallback(() => {
    if (!project.data) return;
    promoteIndependentProject(project.data.id);
    void navigate({
      to: "/p/$projectSlug/$",
      params: { projectSlug: project.data.slug, _splat: "" },
    });
  }, [navigate, project.data]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background text-foreground">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-3">
        <IconButton
          size="sm"
          aria-label={t`Back to home`}
          onClick={() => void navigate({ to: "/home" })}
        >
          <ArrowLeft className="size-4" aria-hidden />
        </IconButton>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {thread?.title?.trim() || <Trans>New chat</Trans>}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handlePromote}
          disabled={!project.data}
        >
          <FolderPlus className="size-3.5" aria-hidden />
          <Trans>Create project</Trans>
        </Button>
      </header>
      {project.isError ? (
        <InlineErrorRow message={t`Project couldn’t load`} onRetry={() => void project.refetch()} />
      ) : null}

      <main className="min-h-0 flex-1">
        <DraftReviewProvider
          projectId={projectId}
          workId={thread?.workId ?? null}
          owningWorkLabel={activeWork?.name ?? null}
          threadId={threadId}
        >
          <ChatView
            threadId={threadId}
            projectId={projectId}
            activeThread={thread}
            activeWork={activeWork}
            snapshotLiveState={snapshotLiveState}
            snapshotNextSeq={snapshotNextSeq}
            historySettled={historySettled}
            key={threadId}
          />
        </DraftReviewProvider>
      </main>
    </div>
  );
}
