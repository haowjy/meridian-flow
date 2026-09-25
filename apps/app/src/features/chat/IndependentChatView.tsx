/**
 * IndependentChatView — standalone chat route for a thread outside the full
 * project workspace chrome, with promotion back into a project when needed.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { ArrowLeft, FolderPlus } from "lucide-react";
import { useCallback } from "react";
import { getProject } from "@/client/api/projects-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { useThreadSnapshotSync } from "@/client/query/useThreadSnapshotSync";
import { useWorks, workFromSnapshot } from "@/client/query/useWorks";
import { promoteIndependentProject } from "@/client/stores";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { ChatView } from "@/features/chat/ChatView";
import { DraftReviewProvider } from "@/features/chat/DraftReviewProvider";
import { EditorReviewHandoffProvider } from "@/features/project/dock/editor-review-handoff";
import { ProjectDraftApplyRecoveryExecutor } from "@/features/project/draft-apply-recovery/ProjectDraftApplyRecoveryExecutor";
import type { OpenContextRoute } from "@/features/project/routing/ProjectNavigationContext";
import { ProjectNavigationProvider } from "@/features/project/routing/ProjectNavigationContext";
import { projectAddressHref } from "@/features/project/routing/project-address";

/**
 * Independent chat surface (`/chat/:threadId`) — a thread the user experiences
 * as project-less. Minimal chrome: no Rail, no panels. A back button returns to
 * the project library; "Create project" promotes the hidden project backing this chat and
 * routes into the full workspace.
 */
export type IndependentChatViewProps = {
  threadId: string;
};

export function IndependentChatView({ threadId }: IndependentChatViewProps) {
  const navigate = useNavigate();
  const {
    thread,
    activateProjection,
    liveState: snapshotLiveState,
    nextSeq: snapshotNextSeq,
    settled: historySettled,
    isError: snapshotIsError,
    refetch: refetchSnapshot,
  } = useThreadSnapshotSync(threadId);
  const projectId = thread?.projectId ?? null;

  if (!projectId || !thread) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col bg-background text-foreground">
        <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-3">
          <IconButton
            size="sm"
            aria-label={t`View projects`}
            onClick={() => void navigate({ to: "/" })}
          >
            <ArrowLeft className="size-4" aria-hidden />
          </IconButton>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {thread?.title?.trim() || <Trans>New chat</Trans>}
          </span>
        </header>
        <main className="min-h-0 flex-1">
          {snapshotIsError ? (
            <InlineErrorRow message={t`Chat couldn’t load`} onRetry={refetchSnapshot} />
          ) : (
            <p role="status" className="px-4 py-3 text-sm text-muted-foreground">
              <Trans>Loading chat…</Trans>
            </p>
          )}
        </main>
      </div>
    );
  }

  return (
    <IndependentChatProjectView
      threadId={threadId}
      projectId={projectId}
      thread={thread}
      activateProjection={activateProjection}
      snapshotLiveState={snapshotLiveState}
      snapshotNextSeq={snapshotNextSeq}
      historySettled={historySettled}
    />
  );
}

function IndependentChatProjectView({
  threadId,
  projectId,
  thread,
  activateProjection,
  snapshotLiveState,
  snapshotNextSeq,
  historySettled,
}: {
  threadId: string;
  projectId: string;
  thread: NonNullable<ReturnType<typeof useThreadSnapshotSync>["thread"]>;
  activateProjection: ReturnType<typeof useThreadSnapshotSync>["activateProjection"];
  snapshotLiveState: ReturnType<typeof useThreadSnapshotSync>["liveState"];
  snapshotNextSeq: ReturnType<typeof useThreadSnapshotSync>["nextSeq"];
  historySettled: boolean;
}) {
  const navigate = useNavigate();
  const router = useRouter();

  const project = useQuery({
    queryKey: projectQueryKeys.detail(projectId),
    queryFn: () => getProject(projectId),
  });

  const { works, noWork } = useWorks(projectId);
  const activeWork = workFromSnapshot(
    noWork ? { works: works ?? [], noWork } : null,
    thread.workId ?? null,
  );
  const workLabels = Object.fromEntries((works ?? []).map((work) => [work.id, work.name]));
  const openContextRoute = useCallback<OpenContextRoute>(
    async (target, options) => {
      if (options?.canCommit && !options.canCommit()) return { kind: "superseded" };
      const workSlug = target.workId
        ? (works ?? []).find((work) => work.id === target.workId)?.slug
        : null;
      if (target.workId && !workSlug) return { kind: "cancelled" };
      await router.navigate({
        href: projectAddressHref({
          projectId,
          destination: {
            kind: "document",
            scheme: target.scheme,
            path: target.path,
            workSlug: workSlug ?? null,
          },
          chat: { kind: "absent" },
          work: { kind: "absent" },
          results: false,
        }),
        replace: options?.replace,
      });
      return { kind: "applied" };
    },
    [projectId, router, works],
  );
  const openNewChat = useCallback(async () => {
    await router.navigate({
      href: projectAddressHref({
        projectId,
        destination: { kind: "chat-index" },
        chat: { kind: "absent" },
        work: { kind: "absent" },
        results: false,
      }),
    });
  }, [projectId, router]);

  const handlePromote = useCallback(() => {
    if (!project.data) return;
    promoteIndependentProject(project.data.id);
    void navigate({
      to: "/p/$projectId/$",
      params: { projectId: project.data.id, _splat: "" },
    });
  }, [navigate, project.data]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background text-foreground">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-3">
        <IconButton
          size="sm"
          aria-label={t`View projects`}
          onClick={() => void navigate({ to: "/" })}
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
        <ProjectNavigationProvider
          screen="chat"
          openContextRoute={openContextRoute}
          openNewChat={openNewChat}
        >
          <EditorReviewHandoffProvider projectId={projectId} openContextRoute={openContextRoute}>
            <ProjectDraftApplyRecoveryExecutor
              projectId={projectId}
              scopeKey={`${activeWork?.id ?? ""}:`}
              mobileHostDocumentId={null}
              inlineDocumentIds={[]}
              desktopHostDocumentIds={[]}
              workLabels={workLabels}
            >
              <DraftReviewProvider
                projectId={projectId}
                workId={activeWork?.id ?? null}
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
                  activateProjection={activateProjection}
                  key={threadId}
                />
              </DraftReviewProvider>
            </ProjectDraftApplyRecoveryExecutor>
          </EditorReviewHandoffProvider>
        </ProjectNavigationProvider>
      </main>
    </div>
  );
}
