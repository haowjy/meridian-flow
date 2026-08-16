/** Focused Work detail composition with independently resilient resources. */
import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import type { ProjectContextTreeDirectory } from "@meridian/contracts/protocol";
import { parseRequestId } from "@meridian/contracts/request-id";
import type { Work } from "@meridian/contracts/works";
import { useBlocker } from "@tanstack/react-router";
import {
  Archive,
  ArchiveRestore,
  ChevronLeft,
  MessageSquare,
  NotebookPen,
  Upload,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useProjectContextTree } from "@/client/query/useProjectContextTree";
import { activeWorkDraftGroups, useWorkDrafts } from "@/client/query/useWorkDrafts";
import { useWorkMutations } from "@/client/query/useWorks";
import { useWorkThreads } from "@/client/query/useWorkThreads";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ProjectRouteCommands } from "../routing/project-route";
import {
  useWorkMetadataController,
  WorkMetadata,
  type WorkMetadataController,
} from "./WorkMetadata";
import { ResourceError, WorkDialog, type WorkScreenProps } from "./WorkScreen";

export function WorkDetailScreen({
  projectId,
  work,
  routeCommands,
  onOpenThread,
}: WorkScreenProps & { work: Work }) {
  const metadataMutation = useWorkMutations(projectId);
  const lifecycleMutation = useWorkMutations(projectId);
  const controller = useWorkMetadataController(
    work,
    (data) =>
      metadataMutation.mutateAsync({ type: "update", workId: work.id, data }) as Promise<Work>,
  );
  const [manage, setManage] = useState(false);
  const blocker = useBlocker({
    shouldBlockFn: () => controller.dirty || controller.saving,
    enableBeforeUnload: () => controller.dirty,
    withResolver: true,
  });
  useEffect(() => {
    if (blocker.status === "blocked" && !controller.held)
      controller.request({
        label: t`Continue navigation`,
        run: blocker.proceed,
        cancel: blocker.reset,
      });
  }, [blocker, controller]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (controller.dirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [controller.dirty]);
  return (
    <div className="app-scroll">
      <article className="project-screen-column gap-10 pb-12">
        <WorkMetadata controller={controller} />
        <div className="flex items-center justify-between gap-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void routeCommands.closeWork({ replace: true })}
            className="[@media(pointer:coarse)]:min-h-11"
          >
            <ChevronLeft className="size-4" />
            <Trans>All Work</Trans>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              controller.request({
                label: t`Manage Work`,
                run: () => {
                  lifecycleMutation.reset();
                  setManage(true);
                },
              })
            }
            className="[@media(pointer:coarse)]:min-h-11"
          >
            {controller.work.status === "archived" ? (
              <ArchiveRestore className="size-4" />
            ) : (
              <Archive className="size-4" />
            )}
            <Trans>Manage Work</Trans>
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-border-subtle px-2 py-0.5 text-meta text-muted-foreground">
            {controller.work.status === "archived" ? (
              <Trans>Archived</Trans>
            ) : (
              <Trans>Active</Trans>
            )}
          </span>
        </div>
        <Drafts
          projectId={projectId}
          work={controller.work}
          commands={routeCommands}
          controller={controller}
        />
        <div className="grid gap-6 @2xl/project-home:grid-cols-2">
          <TreeSummary
            projectId={projectId}
            work={controller.work}
            scheme="scratch"
            icon={NotebookPen}
            commands={routeCommands}
            controller={controller}
          />
          <TreeSummary
            projectId={projectId}
            work={controller.work}
            scheme="uploads"
            icon={Upload}
            commands={routeCommands}
            controller={controller}
          />
        </div>
        <Chats
          projectId={projectId}
          work={controller.work}
          onOpenThread={onOpenThread}
          controller={controller}
        />
        <WorkDialog
          work={manage ? controller.work : null}
          pending={lifecycleMutation.isPending}
          error={lifecycleMutation.error}
          onClose={() => {
            if (!lifecycleMutation.isPending) {
              lifecycleMutation.reset();
              setManage(false);
            }
          }}
          onAction={(action) =>
            lifecycleMutation.mutate(action, {
              onSuccess: () => {
                setManage(false);
                if (action.type === "delete") void routeCommands.closeWork({ replace: true });
              },
            })
          }
        />
        <DirtyDecision controller={controller} />
      </article>
    </div>
  );
}
function Drafts({
  projectId,
  work,
  commands,
  controller,
}: {
  projectId: string;
  work: Work;
  commands: ProjectRouteCommands;
  controller: WorkMetadataController;
}) {
  const query = useWorkDrafts(projectId, work.id);
  const groups = activeWorkDraftGroups(query.groups);
  const workId = parseRequestId(work.id);
  return (
    <ResourceSection title={t`Pending drafts`}>
      {query.status === "loading" ? (
        <Loading />
      ) : query.status === "error" ? (
        <ResourceError label={t`Pending drafts`} retry={query.refetch} />
      ) : groups.length ? (
        <ul className="divide-y divide-border-subtle rounded-lg border">
          {groups.map((group) => (
            <li key={group.documentId}>
              <button
                type="button"
                className="focus-ring flex min-h-11 w-full items-center justify-between px-4 py-3 text-left text-sm"
                disabled={!group.contextPath || !workId}
                onClick={() =>
                  controller.request({
                    label: t`Open manuscript draft`,
                    run: () => {
                      if (group.contextPath && workId)
                        void commands.openWorkContext(
                          {
                            kind: "work-context",
                            workId,
                            scheme: "manuscript",
                            path: group.contextPath,
                          },
                          { replace: false },
                        );
                    },
                  })
                }
              >
                <span className="min-w-0 break-words">
                  {group.documentName || group.contextPath || t`Untitled manuscript`}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  <Plural
                    value={group.drafts.length}
                    one="# pending draft"
                    other="# pending drafts"
                  />
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>
          <Trans>No pending drafts.</Trans>
        </Empty>
      )}
    </ResourceSection>
  );
}
function TreeSummary({
  projectId,
  work,
  scheme,
  icon: Icon,
  commands,
  controller,
}: {
  projectId: string;
  work: Work;
  scheme: "scratch" | "uploads";
  icon: typeof NotebookPen;
  commands: ProjectRouteCommands;
  controller: WorkMetadataController;
}) {
  const query = useProjectContextTree(projectId, scheme, { workId: work.id });
  const count = query.tree ? countFiles(query.tree) : 0;
  const label = scheme === "scratch" ? t`Scratch` : t`Uploads`;
  const workId = parseRequestId(work.id);
  return (
    <ResourceSection title={label}>
      {query.isError ? (
        <ResourceError label={label} retry={query.refetch} />
      ) : !query.tree ? (
        <Loading />
      ) : (
        <button
          type="button"
          className="focus-ring flex min-h-16 w-full items-center gap-3 rounded-lg border px-4 text-left"
          onClick={() =>
            controller.request({
              label: t`Open ${label}`,
              run: () => {
                if (workId)
                  void commands.openWorkContext(
                    { kind: "work-context", workId, scheme },
                    { replace: false },
                  );
              },
            })
          }
        >
          <Icon className="size-4" />
          <span>
            <span className="block text-sm font-medium">{t`Open ${label}`}</span>
            <span className="text-meta text-muted-foreground">
              {count ? (
                <Plural value={count} one="# item" other="# items" />
              ) : (
                <Trans>Nothing here yet</Trans>
              )}
            </span>
          </span>
        </button>
      )}
    </ResourceSection>
  );
}
function Chats({
  projectId,
  work,
  onOpenThread,
  controller,
}: {
  projectId: string;
  work: Work;
  onOpenThread: (id: string) => void;
  controller: WorkMetadataController;
}) {
  const query = useWorkThreads(projectId, work.id);
  return (
    <ResourceSection title={t`Associated chats`}>
      {query.isError ? (
        <ResourceError label={t`Associated chats`} retry={query.refetch} />
      ) : query.threads === null ? (
        <Loading />
      ) : query.threads.length ? (
        <ul className="divide-y divide-border-subtle rounded-lg border">
          {query.threads.map((thread) => (
            <li key={thread.id}>
              <button
                type="button"
                className="focus-ring flex min-h-11 w-full items-center gap-3 px-4 py-3 text-left"
                onClick={() =>
                  controller.request({ label: t`Open chat`, run: () => onOpenThread(thread.id) })
                }
              >
                <MessageSquare className="size-4" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">
                    {thread.title || t`Untitled chat`}
                  </span>
                  <span className="flex flex-wrap gap-x-2 text-meta text-muted-foreground">
                    <span>
                      {thread.runningTurnId ? (
                        <Trans>Writing</Trans>
                      ) : thread.attention === "actionRequired" ? (
                        <Trans>Needs attention</Trans>
                      ) : thread.attention === "unread" ? (
                        <Trans>Unread</Trans>
                      ) : (
                        <Trans>Ready</Trans>
                      )}
                    </span>
                    <span>
                      <Plural value={thread.turnCount} one="# turn" other="# turns" />
                    </span>
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>
          <Trans>No chats are associated with this Work.</Trans>
        </Empty>
      )}
    </ResourceSection>
  );
}
function ResourceSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}
function Loading() {
  return (
    <p role="status" className="text-sm text-muted-foreground">
      <Trans>Loading…</Trans>
    </p>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}
function countFiles(node: ProjectContextTreeDirectory): number {
  return node.children.reduce(
    (sum, child) => sum + (child.kind === "dir" ? countFiles(child) : 1),
    0,
  );
}

function DirtyDecision({ controller }: { controller: WorkMetadataController }) {
  return (
    <Dialog open={Boolean(controller.held)} onOpenChange={() => undefined}>
      <DialogContent
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            <Trans>Save metadata changes?</Trans>
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          <Trans>Choose what to do before continuing.</Trans>
        </p>
        {controller.error ? (
          <p role="alert" className="text-sm text-destructive">
            {controller.error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={controller.saving}
            onClick={controller.keepEditing}
            className="[@media(pointer:coarse)]:min-h-11"
          >
            <Trans>Keep editing</Trans>
          </Button>
          <Button
            variant="outline"
            disabled={controller.saving}
            onClick={controller.discardAndResume}
            className="[@media(pointer:coarse)]:min-h-11"
          >
            <Trans>Discard changes</Trans>
          </Button>
          <Button
            disabled={controller.saving}
            onClick={() => void controller.saveAndResume()}
            className="[@media(pointer:coarse)]:min-h-11"
          >
            {controller.saving ? <Trans>Saving…</Trans> : <Trans>Save changes</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
