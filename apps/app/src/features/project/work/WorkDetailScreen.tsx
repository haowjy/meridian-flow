/** Focused Work detail composition with independently resilient resources. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectChatItem } from "@meridian/contracts/protocol";
import type { Work } from "@meridian/contracts/works";
import { MessageSquarePlus, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useProjectChatFeed } from "@/client/query/useProjectChatFeed";
import { useWorkMutations } from "@/client/query/work-command-store";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { useMinuteClock } from "@/hooks/use-minute-clock";
import { NextPage } from "../chat-index/ChatIndex";
import { ChatIndexList, type ChatIndexRowProps } from "../chat-index/ChatIndexList";
import { ChatIndexLoading } from "../chat-index/ChatIndexLoading";
import { useChatRowCommands } from "../chat-list/useChatRowCommands";
import { useChatNavigation } from "../routing/chat-navigation";
import { useProjectLeaveGuard } from "../routing/ProjectNavigationContext";
import type { ProjectRouteCommands } from "../routing/project-route";
import { useWorkFiles, WorkFilesActions, WorkFilesView } from "./WorkFilesView";
import {
  useWorkMetadataController,
  WorkDescription,
  type WorkMetadataController,
} from "./WorkMetadata";
import { WorkHeading } from "./WorkTitles";

export type WorkDetailScreenProps = {
  projectId: string;
  work: Work;
  routeCommands: ProjectRouteCommands;
};

/**
 * The Work page's own header block under the band: the description (or a
 * pending Work's state), then one sticky toolbar row.
 */
export function WorkScreenHeader({
  description,
  view,
  onViewChange,
  tools,
  pending = false,
}: {
  description?: React.ReactNode;
  view: "chats" | "files";
  onViewChange: (view: "chats" | "files") => void;
  tools: React.ReactNode;
  pending?: boolean;
}) {
  return (
    <>
      {description ? (
        <header className="flex min-w-0 flex-col gap-1.5">{description}</header>
      ) : null}
      <div className="sticky top-0 z-10 -my-2 flex min-w-0 items-center gap-2 bg-background py-2 sm:gap-3">
        <SegmentedTabs
          label={t`Work view`}
          value={view}
          onChange={onViewChange}
          options={[
            { value: "chats", label: <Trans>Chats</Trans>, disabled: pending },
            { value: "files", label: <Trans>Files</Trans>, disabled: pending },
          ]}
        />
        {tools}
      </div>
    </>
  );
}

function useWorkView(
  routeCommands: ProjectRouteCommands,
): ["chats" | "files", (view: "chats" | "files") => void] {
  return [routeCommands.workView, routeCommands.setWorkView];
}

export function WorkDetailScreen({ projectId, work, routeCommands }: WorkDetailScreenProps) {
  const mutations = useWorkMutations(projectId);
  const controller = useWorkMetadataController(work, async (data) => {
    const error = await mutations.update({ workId: work.id, data });
    if (error) throw error;
  });
  const [view, setView] = useWorkView(routeCommands);
  const [searchText, setSearchText] = useState("");
  const [settledSearch, setSettledSearch] = useState<string | null>(null);
  const [filesSearch, setFilesSearch] = useState("");
  const files = useWorkFiles(projectId, work);
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
    request: controller.request,
    dirty: () => controller.dirty,
    cancel: controller.keepEditing,
  });
  return (
    <div ref={scrollOwner} className="app-scroll">
      <article className="project-screen-column min-w-0 gap-5 pb-12">
        <WorkScreenHeader
          description={
            <>
              <WorkHeading projectId={projectId} work={work} />
              <WorkDescription work={work} controller={controller} />
            </>
          }
          view={view}
          onViewChange={setView}
          tools={
            <>
              <div className="relative min-w-0 flex-1">
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
                  aria-label={t`New chat`}
                  className="[@media(pointer:coarse)]:min-h-11"
                >
                  <MessageSquarePlus aria-hidden />
                  <span className="max-sm:hidden" aria-hidden>
                    <Trans>New chat</Trans>
                  </span>
                </Button>
              ) : (
                <WorkFilesActions files={files} />
              )}
            </>
          }
        />
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
          <WorkFilesView
            projectId={projectId}
            work={work}
            commands={routeCommands}
            search={filesSearch}
            files={files}
          />
        )}
        {deleteDialog}
        <DirtyDecision controller={controller} />
      </article>
    </div>
  );
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
      <NextPage feed={feed} />
    </>
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
            <Trans>Save description changes?</Trans>
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
