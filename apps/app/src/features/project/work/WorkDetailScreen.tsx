/** Focused Work detail composition with independently resilient resources. */
import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import type { ProjectChatItem } from "@meridian/contracts/protocol";
import { parseRequestId } from "@meridian/contracts/request-id";
import type { Work } from "@meridian/contracts/works";
import { useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  ChevronLeft,
  FileText,
  Folder,
  Pencil,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { deleteContextEntry } from "@/client/api/projects-api";
import { uploadIntakePort } from "@/client/api/upload-intake-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { useContextCatalogView } from "@/client/query/useContextCatalog";
import { useCreateContextEntry } from "@/client/query/useCreateContextEntry";
import { useProjectChatFeed } from "@/client/query/useProjectChatFeed";
import { activeWorkDraftGroups, useWorkDrafts } from "@/client/query/useWorkDrafts";
import { useWorkMutations } from "@/client/query/useWorks";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { OverflowMenu } from "@/components/ui/overflow-menu";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { useMinuteClock } from "@/hooks/use-minute-clock";
import { ChatIndexList, type ChatIndexRowProps } from "../chat-index/ChatIndexList";
import { ChatIndexLoading } from "../chat-index/ChatIndexLoading";
import { useChatRowCommands } from "../chat-list/useChatRowCommands";
import { useRenameEntryForm } from "../context/use-rename-entry-form";
import { useDockViewStore, useOpenFileInDock } from "../dock/dock-view-store";
import { usePostApplyDraftGroupProjections } from "../draft-apply-recovery/DraftApplyRecoveryProvider";
import { useChatNavigation } from "../routing/chat-navigation";
import { useProjectLeaveGuard } from "../routing/ProjectNavigationContext";
import type { ProjectRouteCommands } from "../routing/project-route";
import {
  useWorkMetadataController,
  WorkMetadata,
  type WorkMetadataController,
} from "./WorkMetadata";
import { focusAfterDelete, holdWorkCollectionFocus } from "./work-focus-intent";

export type WorkDetailScreenProps = {
  projectId: string;
  work: Work;
  routeCommands: ProjectRouteCommands;
  catalogWorks?: Work[];
};

function useWorkView(): ["chats" | "files", (view: "chats" | "files") => void] {
  const [view, setCurrentView] = useState<"chats" | "files">(() =>
    new URLSearchParams(window.location.search).get("view") === "files" ? "files" : "chats",
  );
  const setView = useCallback((next: "chats" | "files") => {
    setCurrentView(next);
    const url = new URL(window.location.href);
    if (next === "files") url.searchParams.set("view", "files");
    else url.searchParams.delete("view");
    window.history.replaceState(window.history.state, "", url);
  }, []);
  return [view, setView];
}

export function WorkDetailScreen({
  projectId,
  work,
  routeCommands,
  catalogWorks = [work],
}: WorkDetailScreenProps) {
  const mutations = useWorkMutations(projectId);
  const controller = useWorkMetadataController(work, (data) =>
    mutations.update.mutateAsync({ workId: work.id, data }),
  );
  const [view, setView] = useWorkView();
  const [searchText, setSearchText] = useState("");
  const [settledSearch, setSettledSearch] = useState<string | null>(null);
  const [filesSearch, setFilesSearch] = useState("");
  const scrollOwner = useRef<HTMLDivElement>(null);
  const feed = useProjectChatFeed(projectId, false, settledSearch, work.id);
  const now = useMinuteClock();
  const { openChat, openNewChat } = useChatNavigation();
  const { onFavorite, onDelete, deleteFailure, retryDelete, deleteDialog } =
    useChatRowCommands(projectId);
  const onOpen = useCallback<ChatIndexRowProps["onOpen"]>(
    (item) => void openChat(item.id),
    [openChat],
  );
  const rowProps: ChatIndexRowProps = useMemo(
    () => ({ onFavorite, onDelete, now, onOpen }),
    [onFavorite, onDelete, now, onOpen],
  );
  useEffect(() => {
    const timer = window.setTimeout(
      () => setSettledSearch(searchText.trim() || null),
      searchText.trim() ? 200 : 0,
    );
    return () => window.clearTimeout(timer);
  }, [searchText]);
  useProjectLeaveGuard({
    request: (intent) => controller.request({ ...intent, label: t`Continue navigation` }),
    dirty: () => controller.dirty,
    cancel: controller.keepEditing,
  });
  return (
    <div ref={scrollOwner} className="app-scroll">
      <article className="project-screen-column min-w-0 gap-5 pb-12">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            holdWorkCollectionFocus(projectId, { kind: "heading" });
            void routeCommands.closeWork({ replace: true });
          }}
          className="-ml-2 w-fit [@media(pointer:coarse)]:min-h-11"
        >
          <ChevronLeft className="size-4" />
          <Trans>All Work</Trans>
        </Button>
        <WorkMetadata
          controller={controller}
          identityChrome={
            <OverflowMenu
              label={t`Work actions`}
              triggerClassName="[@media(pointer:coarse)]:size-11"
            >
              <DropdownMenuItem
                disabled={mutations.isPending}
                onSelect={() =>
                  (controller.work.status === "archived"
                    ? mutations.unarchive
                    : mutations.archive
                  ).mutate(controller.work.id)
                }
              >
                {controller.work.status === "archived" ? (
                  <ArchiveRestore className="size-4" />
                ) : (
                  <Archive className="size-4" />
                )}
                {controller.work.status === "archived" ? (
                  <Trans>Unarchive</Trans>
                ) : (
                  <Trans>Archive</Trans>
                )}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={mutations.isPending}
                onSelect={() =>
                  mutations.delete.mutate(controller.work.id, {
                    onSuccess: () => {
                      holdWorkCollectionFocus(
                        projectId,
                        focusAfterDelete(catalogWorks, controller.work.id),
                      );
                      void routeCommands.closeWork({ replace: true });
                    },
                  })
                }
              >
                <Trans>Delete Work</Trans>
              </DropdownMenuItem>
            </OverflowMenu>
          }
        />
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge>
            {controller.work.status === "archived" ? (
              <Trans>Archived</Trans>
            ) : (
              <Trans>Active</Trans>
            )}
          </Badge>
          <span>
            <Trans>Updated</Trans> {relativeUpdated(controller.work.updatedAt)}
          </span>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-3 border-b pb-3">
          <SegmentedTabs
            label={t`Work view`}
            value={view}
            onChange={setView}
            options={[
              { value: "chats", label: <Trans>Chats</Trans> },
              { value: "files", label: <Trans>Files</Trans> },
            ]}
          />
          <div className="relative min-w-0 flex-1 basis-40 sm:max-w-[260px]">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              type="search"
              aria-label={view === "chats" ? t`Search chats` : t`Search files`}
              placeholder={view === "chats" ? t`Search chats` : t`Search files`}
              value={view === "chats" ? searchText : filesSearch}
              onChange={(event) =>
                view === "chats"
                  ? setSearchText(event.target.value)
                  : setFilesSearch(event.target.value)
              }
              className="h-8 pl-8 [@media(pointer:coarse)]:h-11"
            />
          </div>
          {view === "chats" ? (
            <Button
              size="sm"
              onClick={() => void openNewChat(work.id)}
              className="[@media(pointer:coarse)]:min-h-11"
            >
              <Trans>New chat</Trans>
            </Button>
          ) : null}
        </div>
        {view === "chats" ? (
          <WorkChatList
            projectId={projectId}
            feed={feed}
            search={settledSearch}
            scrollOwner={scrollOwner}
            rowProps={rowProps}
            deleteFailure={deleteFailure}
            retryDelete={retryDelete}
          />
        ) : (
          <FilesView
            projectId={projectId}
            work={controller.work}
            commands={routeCommands}
            search={filesSearch}
          />
        )}
        {deleteDialog}
        <DirtyDecision controller={controller} />
      </article>
    </div>
  );
}
function relativeUpdated(value: string) {
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  if (elapsed < 60_000) return t`just now`;
  if (elapsed < 3_600_000) return t`${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return t`${Math.floor(elapsed / 3_600_000)}h ago`;
  return t`${Math.floor(elapsed / 86_400_000)}d ago`;
}
function WorkChatList({
  projectId,
  feed,
  search,
  scrollOwner,
  rowProps,
  deleteFailure,
  retryDelete,
}: {
  projectId: string;
  feed: ReturnType<typeof useProjectChatFeed>;
  search: string | null;
  scrollOwner: React.RefObject<HTMLDivElement | null>;
  rowProps: ChatIndexRowProps;
  deleteFailure: ReturnType<typeof useChatRowCommands>["deleteFailure"];
  retryDelete: () => void;
}) {
  if (feed.isPending) return <ChatIndexLoading />;
  if (feed.isError && !feed.data)
    return (
      <InlineErrorRow
        message={<Trans>Chats couldn’t load</Trans>}
        onRetry={() => void feed.refetch()}
      />
    );
  if (!feed.items.length && !feed.hasNextPage && !feed.isPlaceholderData)
    return (
      <div className="py-4">
        {search ? (
          <p className="text-sm text-muted-foreground">
            <Trans>No chats match “{search}”.</Trans>
          </p>
        ) : (
          <>
            <p className="text-sm font-medium">
              <Trans>Start a chat in this Work</Trans>
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              <Trans>Chats you start here stay with this Work.</Trans>
            </p>
          </>
        )}
      </div>
    );
  return (
    <>
      <ChatIndexList
        projectId={projectId}
        items={feed.items as readonly ProjectChatItem[]}
        complete={!feed.hasNextPage}
        busy={feed.isFetching}
        scrollOwner={scrollOwner}
        rowProps={rowProps}
        deleteFailure={deleteFailure}
        retryDelete={retryDelete}
      />
      <WorkChatNextPage feed={feed} />
    </>
  );
}
function WorkChatNextPage({ feed }: { feed: ReturnType<typeof useProjectChatFeed> }) {
  const sentinel = useRef<HTMLDivElement>(null);
  const pages = feed.data?.pages.length;
  const { fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError } = feed;
  useEffect(() => {
    if (!sentinel.current || !hasNextPage || isFetchingNextPage || isFetchNextPageError) return;
    let active = true;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!active || !entry?.isIntersecting) return;
        active = false;
        void fetchNextPage();
      },
      { rootMargin: "240px" },
    );
    observer.observe(sentinel.current);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError, pages]);
  if (isFetchNextPageError)
    return (
      <InlineErrorRow
        message={<Trans>More chats couldn’t load.</Trans>}
        onRetry={() => void fetchNextPage()}
      />
    );
  return <div ref={sentinel} aria-hidden className="h-px" />;
}
function FilesView({
  projectId,
  work,
  commands,
  search,
}: {
  projectId: string;
  work: Work;
  commands: ProjectRouteCommands;
  search: string;
}) {
  const scratch = useContextCatalogView(projectId, "scratch", { workId: work.id });
  const uploads = useContextCatalogView(projectId, "uploads", { workId: work.id });
  const create = useCreateContextEntry(projectId);
  const queryClient = useQueryClient();
  const openFile = useOpenFileInDock(work.id);
  const openDockFile = useDockViewStore((state) => state.workFile);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set());
  const [rename, setRename] = useState<{ path: string; name: string } | null>(null);
  const [uploading, setUploading] = useState<
    { name: string; state: "uploading" | "failed"; error?: string }[]
  >([]);
  const picker = useRef<HTMLInputElement>(null);
  const workId = parseRequestId(work.id);
  const matches = (name: string) =>
    !search.trim() || name.toLowerCase().includes(search.trim().toLowerCase());
  const submitFiles = async (files: FileList | File[]) => {
    const candidates = Array.from(files);
    for (const file of candidates) {
      const intakeId = crypto.randomUUID();
      setUploading((items) => [...items, { name: file.name, state: "uploading" }]);
      try {
        await uploadIntakePort.intake({
          file,
          intakeId,
          scope: { kind: "work", projectId, workId: work.id },
        });
        setUploading((items) => items.filter((item) => item.name !== file.name));
        void queryClient.invalidateQueries({
          queryKey: projectQueryKeys.contextCatalogView(projectId, "uploads", work.id),
        });
      } catch (cause) {
        setUploading((items) =>
          items.map((item) =>
            item.name === file.name
              ? {
                  ...item,
                  state: "failed",
                  error: cause instanceof Error ? cause.message : String(cause),
                }
              : item,
          ),
        );
      }
    }
  };
  const createScratch = async () => {
    const name = `Scratch note ${new Date().toLocaleDateString().replaceAll("/", "-")}.md`;
    try {
      await create.mutateAsync({
        scheme: "scratch",
        type: "file",
        path: name,
        content: "",
        workId: work.id,
      });
      setRename({ path: name, name });
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.contextCatalogView(projectId, "scratch", work.id),
      });
    } catch {
      /* the catalog query exposes the failed create on refresh */
    }
  };
  const scratchFiles =
    scratch.catalog
      ?.files()
      .filter(
        (file) =>
          matches(file.name) &&
          (file.parentId === scratch.catalog?.root.entryId ||
            [...expandedFolders].some((path) => file.path.startsWith(`${path}/`))),
      ) ?? [];
  const scratchFolders =
    scratch.catalog
      ?.children(scratch.catalog.root.entryId)
      .filter((node) => node.kind === "dir" && matches(node.name)) ?? [];
  const uploadFiles = uploads.catalog?.files().filter((file) => matches(file.name)) ?? [];
  return (
    <div className="min-w-0 space-y-5 pt-1">
      <Drafts projectId={projectId} work={work} commands={commands} search={search} />
      <ResourceSection title={t`Scratch`}>
        {scratch.isError ? (
          <InlineErrorRow message={t`Scratch couldn’t load`} onRetry={scratch.refetch} />
        ) : !scratch.catalog ? (
          <Loading />
        ) : scratchFiles.length || scratchFolders.length ? (
          <ul className="min-w-0">
            {scratchFolders.map((folder) => (
              <li key={folder.entryId}>
                <button
                  type="button"
                  className="focus-ring flex h-7 w-full items-center gap-2 rounded-sm px-1 text-left text-sm hover:bg-muted/50"
                  aria-expanded={expandedFolders.has(folder.path)}
                  onClick={() =>
                    setExpandedFolders((current) => {
                      const next = new Set(current);
                      if (next.has(folder.path)) next.delete(folder.path);
                      else next.add(folder.path);
                      return next;
                    })
                  }
                >
                  <Folder className="size-3.5 text-muted-foreground" aria-hidden />
                  <span className="truncate">{folder.name}</span>
                </button>
              </li>
            ))}
            {scratchFiles.map((file) => (
              <li key={file.entryId}>
                {rename?.path === file.path || rename?.name === file.name ? (
                  <InlineRename
                    projectId={projectId}
                    workId={work.id}
                    scheme="scratch"
                    file={file}
                    siblingNames={scratchFiles.map((item) => item.name)}
                    onDone={() => setRename(null)}
                  />
                ) : (
                  <div className="group flex h-7 min-w-0 items-center gap-1 rounded-sm hover:bg-muted/50">
                    <button
                      type="button"
                      className="focus-ring flex h-7 min-w-0 flex-1 items-center gap-2 rounded-sm px-1 text-left text-sm"
                      onClick={() =>
                        workId &&
                        void commands.openWorkContext(
                          { kind: "work-context", workId, scheme: "scratch", path: file.path },
                          { replace: false },
                        )
                      }
                    >
                      <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{file.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {file.filetype}
                      </span>
                    </button>
                    <OverflowMenu
                      label={t`File actions`}
                      triggerClassName="size-6 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                    >
                      <DropdownMenuItem
                        onSelect={() => setRename({ path: file.path, name: file.name })}
                      >
                        <Pencil className="size-4" />
                        <Trans>Rename</Trans>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() =>
                          void removeCatalogFile(projectId, work.id, "scratch", file, queryClient)
                        }
                      >
                        <Trash2 className="size-4" />
                        <Trans>Delete</Trans>
                      </DropdownMenuItem>
                    </OverflowMenu>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>
            <Trans>No scratch notes yet</Trans>
          </Empty>
        )}
        <button
          type="button"
          className="text-button min-h-7 text-sm"
          disabled={create.isPending}
          onClick={() => void createScratch()}
        >
          <Trans>New scratch note</Trans>
        </button>
      </ResourceSection>
      <ResourceSection title={t`Uploads`}>
        {uploads.isError ? (
          <InlineErrorRow message={t`Uploads couldn’t load`} onRetry={uploads.refetch} />
        ) : !uploads.catalog ? (
          <Loading />
        ) : uploadFiles.length ? (
          <ul className="min-w-0">
            {uploadFiles.map((file) => (
              <li key={file.entryId}>
                <div className="group flex h-7 min-w-0 items-center gap-1 rounded-sm hover:bg-muted/50">
                  <button
                    type="button"
                    className={`focus-ring flex h-7 min-w-0 flex-1 items-center gap-2 rounded-sm px-1 text-left text-sm ${openDockFile?.workId === work.id && openDockFile.tab.path === file.path ? "bg-muted" : ""}`}
                    onClick={() => {
                      if (file.kind === "file" && !file.editable)
                        openFile({
                          kind: "viewer",
                          documentId: file.documentId,
                          scheme: "uploads",
                          path: file.path,
                          name: file.name,
                          workId: work.id,
                          editable: false,
                          fileType: file.fileType,
                          mimeType: file.mimeType,
                        });
                    }}
                  >
                    <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{file.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {file.kind === "file" && !file.editable
                        ? file.fileType
                        : file.kind === "file"
                          ? file.filetype
                          : ""}
                    </span>
                  </button>
                  <OverflowMenu
                    label={t`File actions`}
                    triggerClassName="size-6 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                  >
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() =>
                        void removeCatalogFile(projectId, work.id, "uploads", file, queryClient)
                      }
                    >
                      <Trash2 className="size-4" />
                      <Trans>Delete</Trans>
                    </DropdownMenuItem>
                  </OverflowMenu>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>
            <Trans>No uploads yet</Trans>
          </Empty>
        )}
        <input
          ref={picker}
          type="file"
          multiple
          className="sr-only"
          onChange={(event) => {
            if (event.target.files) void submitFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <button
          type="button"
          className="flex min-h-8 w-full items-center gap-2 rounded-md border border-dashed px-2 text-left text-xs text-muted-foreground hover:border-border hover:text-foreground"
          onClick={() => picker.current?.click()}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            void submitFiles(event.dataTransfer.files);
          }}
        >
          <Upload className="size-3.5" aria-hidden />
          <Trans>Drop files here or choose from your device</Trans>
        </button>
        {uploading.map((item, index) => (
          <p
            key={`${item.name}-${index}`}
            className={`text-xs ${item.state === "failed" ? "text-destructive" : "text-muted-foreground"}`}
          >
            {item.state === "uploading"
              ? t`Uploading ${item.name}…`
              : t`${item.name}: ${item.error ?? "Upload failed"}`}
          </p>
        ))}
      </ResourceSection>
    </div>
  );
}
function Drafts({
  projectId,
  work,
  commands,
  search,
}: {
  projectId: string;
  work: Work;
  commands: ProjectRouteCommands;
  search: string;
}) {
  const query = useWorkDrafts(projectId, work.id);
  const groups = activeWorkDraftGroups(
    usePostApplyDraftGroupProjections(query.groups, projectId, work.id).commandEligibleGroups,
  );
  const workId = parseRequestId(work.id);
  const visibleGroups = groups.filter((group) =>
    matchesFileSearch(group.documentName || group.contextPath || "", search),
  );
  if (query.groups !== null && visibleGroups.length === 0) return null;
  return (
    <ResourceSection title={t`Drafts to review`}>
      {query.status === "loading" ? (
        <Loading />
      ) : query.status === "error" ? (
        <InlineErrorRow
          message={t`Pending drafts couldn’t load`}
          onRetry={query.refetch}
          actionLabel={t`Retry Pending drafts`}
        />
      ) : visibleGroups.length ? (
        <ul className="min-w-0 divide-y divide-border-subtle rounded-lg border">
          {visibleGroups.map((group) => (
            <li key={group.documentId}>
              <button
                type="button"
                className="focus-ring flex h-7 min-w-0 w-full items-center justify-between gap-3 rounded-sm px-1 text-left text-sm hover:bg-muted/50"
                disabled={!group.contextPath || !workId}
                onClick={() => {
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
                }}
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
      ) : null}
    </ResourceSection>
  );
}
function matchesFileSearch(name: string, search: string) {
  return !search.trim() || name.toLowerCase().includes(search.trim().toLowerCase());
}
async function removeCatalogFile(
  projectId: string,
  workId: string,
  scheme: "scratch" | "uploads",
  file: import("@/client/query/context-catalog-projection").CatalogFile,
  client: ReturnType<typeof useQueryClient>,
) {
  if (!window.confirm(t`Delete ${file.name}?`)) return;
  try {
    await deleteContextEntry(
      projectId,
      scheme,
      {
        operationId: crypto.randomUUID(),
        path: file.path,
        expected: { kind: "file", documentId: file.documentId },
      },
      { workId },
    );
    void client.invalidateQueries({
      queryKey: projectQueryKeys.contextCatalogView(projectId, scheme, workId),
    });
  } catch {
    /* preserve the row when the delete does not commit */
  }
}
function InlineRename({
  projectId,
  workId,
  scheme,
  file,
  siblingNames,
  onDone,
}: {
  projectId: string;
  workId: string;
  scheme: "scratch" | "uploads";
  file: import("@/client/query/context-catalog-projection").CatalogFile;
  siblingNames: string[];
  onDone: () => void;
}) {
  const form = useRenameEntryForm({
    projectId,
    entryId: file.entryId,
    workId,
    scheme,
    path: file.path,
    currentName: file.name,
    siblingNames,
    kind: "file",
    onDone,
  });
  return (
    <Input
      ref={form.inputRef}
      value={form.name}
      onChange={form.onChange}
      onKeyDown={form.onKeyDown}
      onBlur={form.onBlur}
      aria-label={t`File name`}
      className="h-7 text-sm"
    />
  );
}
function ResourceSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 space-y-3">
      <h2 className="text-xs font-medium text-muted-foreground">{title}</h2>
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
