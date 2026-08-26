/** Focused Work detail composition with independently resilient resources. */
import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import type { ProjectChatItem, ProjectContextTreeDirectory } from "@meridian/contracts/protocol";
import { parseRequestId } from "@meridian/contracts/request-id";
import type { Work } from "@meridian/contracts/works";
import { useBlocker } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Archive,
  ArchiveRestore,
  ChevronLeft,
  FileText,
  Folder,
  NotebookPen,
  Upload,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useProjectContextTree } from "@/client/query/useProjectContextTree";
import { activeWorkDraftGroups, useWorkDrafts } from "@/client/query/useWorkDrafts";
import { useWorkMutations } from "@/client/query/useWorks";
import { useWorkThreads } from "@/client/query/useWorkThreads";
import { useAnnouncement } from "@/client/stores";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ProjectChatRow } from "../chat-list/ProjectChatRow";
import type { ProjectRouteCommands } from "../routing/project-route";
import {
  useWorkMetadataController,
  WorkMetadata,
  type WorkMetadataController,
} from "./WorkMetadata";
import { focusAfterDelete, ResourceError, WorkDialog, type WorkScreenProps } from "./WorkScreen";
import { holdWorkCollectionFocus } from "./work-focus-intent";

export function WorkDetailScreen({
  projectId,
  work,
  routeCommands,
  onOpenThread,
  catalogWorks = [work],
}: WorkScreenProps & { work: Work; catalogWorks?: Work[] }) {
  const metadataMutation = useWorkMutations(projectId);
  const lifecycleMutation = useWorkMutations(projectId);
  const controller = useWorkMetadataController(
    work,
    (data) =>
      metadataMutation.mutateAsync({ type: "update", workId: work.id, data }) as Promise<Work>,
  );
  const [manage, setManage] = useState(false);
  const manageButton = useRef<HTMLButtonElement>(null);
  const scrollOwner = useRef<HTMLDivElement>(null);
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
  return (
    <div ref={scrollOwner} className="app-scroll">
      <article className="project-screen-column min-w-0 gap-10 pb-12">
        <WorkMetadata
          controller={controller}
          identityChrome={
            <div className="min-w-0 space-y-3">
              <div className="flex items-center gap-2">
                <span className="rounded-full border border-border-subtle px-2 py-0.5 text-meta text-muted-foreground">
                  {controller.work.status === "archived" ? (
                    <Trans>Archived</Trans>
                  ) : (
                    <Trans>Active</Trans>
                  )}
                </span>
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-3 sm:justify-between">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    holdWorkCollectionFocus(projectId, { kind: "heading" });
                    void routeCommands.closeWork({ replace: true });
                  }}
                  className="[@media(pointer:coarse)]:min-h-11"
                >
                  <ChevronLeft className="size-4" />
                  <Trans>All Work</Trans>
                </Button>
                <Button
                  ref={manageButton}
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
            </div>
          }
        />
        <Drafts
          projectId={projectId}
          work={controller.work}
          commands={routeCommands}
          controller={controller}
        />
        <div className="grid min-w-0 gap-6 @2xl/project-home:grid-cols-2">
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
          scrollOwner={scrollOwner}
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
                if (action.type === "delete") {
                  holdWorkCollectionFocus(projectId, focusAfterDelete(catalogWorks, action.workId));
                  void routeCommands.closeWork({ replace: true });
                } else requestAnimationFrame(() => manageButton.current?.focus());
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
        <ul className="min-w-0 divide-y divide-border-subtle rounded-lg border">
          {groups.map((group) => (
            <li key={group.documentId}>
              <button
                type="button"
                className="focus-ring flex min-h-11 min-w-0 w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm"
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
                <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">
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
        <div className="min-w-0 space-y-2">
          <button
            type="button"
            className="focus-ring flex min-h-16 min-w-0 w-full items-center gap-3 rounded-lg border px-4 text-left"
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
            <Icon className="size-4 shrink-0" />
            <span className="min-w-0">
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
          <TreePreview tree={query.tree} />
        </div>
      )}
    </ResourceSection>
  );
}
function Chats({
  projectId,
  work,
  onOpenThread,
  controller,
  scrollOwner,
}: {
  projectId: string;
  work: Work;
  onOpenThread: (id: string) => void;
  controller: WorkMetadataController;
  scrollOwner: React.RefObject<HTMLDivElement | null>;
}) {
  const query = useWorkThreads(projectId, work.id);
  const { announce, announceError } = useAnnouncement();
  const [now, setNow] = useState(Date.now());
  const [list, setList] = useState<HTMLUListElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  useLayoutEffect(() => {
    if (!list) return;
    const measure = () => setScrollMargin(list.offsetTop);
    measure();
    const content = scrollOwner.current?.firstElementChild;
    if (!content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [list, scrollOwner]);
  const virtualizer = useVirtualizer({
    count: query.threads?.length ?? 0,
    getScrollElement: () => scrollOwner.current,
    estimateSize: () => 52,
    getItemKey: (index) => query.threads?.[index]?.id ?? index,
    overscan: 8,
    scrollMargin,
  });
  const rowProps = {
    now,
    onOpen: (item: ProjectChatItem) =>
      controller.request({ label: t`Open chat`, run: () => onOpenThread(item.id) }),
    onFavorite: (item: ProjectChatItem, value: boolean) => {
      void query.setFavorite(item.id, value).then((saved) => {
        if (saved)
          announce(
            value ? t`${item.title} added to favorites` : t`${item.title} removed from favorites`,
          );
        else announceError(t`Favorite wasn’t saved`);
      });
    },
    onUnread: async (item: ProjectChatItem, value: boolean) => {
      const saved = await query.setUnread(item.id, value);
      if (!saved) announceError(t`Read status wasn’t saved`);
      return saved;
    },
    getCommandState: query.getCommandState,
  };
  return (
    <ResourceSection title={t`Associated chats`}>
      {query.isError ? (
        <ResourceError label={t`Associated chats`} retry={query.refetch} />
      ) : query.threads === null ? (
        <Loading />
      ) : query.threads.length ? (
        <>
          <ul
            ref={setList}
            className="relative min-w-0"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const item = query.threads?.[virtualRow.index];
              return item ? (
                <li
                  key={item.id}
                  ref={virtualizer.measureElement}
                  data-index={virtualRow.index}
                  aria-posinset={virtualRow.index + 1}
                  aria-setsize={query.threads?.length}
                  className="absolute top-0 left-0 w-full"
                  style={{
                    transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
                  }}
                >
                  <ProjectChatRow item={item} {...rowProps} />
                </li>
              ) : null;
            })}
          </ul>
          {query.nextPageIdentity ? (
            <Button
              type="button"
              variant="outline"
              disabled={query.isFetchingNextPage}
              onClick={() => {
                if (query.nextPageIdentity) query.fetchNextPageFor(query.nextPageIdentity);
              }}
            >
              {query.isFetchingNextPage ? <Trans>Loading…</Trans> : <Trans>Load more chats</Trans>}
            </Button>
          ) : null}
        </>
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
    <section className="min-w-0 space-y-3">
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
function TreePreview({ tree }: { tree: ProjectContextTreeDirectory }) {
  const visible = tree.children.slice(0, 3);
  if (!visible.length) return null;
  return (
    <ul className="space-y-1 px-1" aria-label={t`Contents preview`}>
      {visible.map((node) => (
        <li
          key={node.path}
          className="flex min-w-0 items-center gap-2 text-meta text-muted-foreground"
        >
          {node.kind === "dir" ? (
            <Folder className="size-3.5 shrink-0" aria-hidden />
          ) : (
            <FileText className="size-3.5 shrink-0" aria-hidden />
          )}
          <span className="min-w-0 truncate">{node.name}</span>
        </li>
      ))}
      {tree.children.length > visible.length ? (
        <li className="text-meta text-muted-foreground">
          <Plural
            value={tree.children.length - visible.length}
            one="# more item"
            other="# more items"
          />
        </li>
      ) : null}
    </ul>
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
