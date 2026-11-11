import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { THREAD_TITLE_MAX_LENGTH, type ThreadListItem } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Layers, Plus, Star } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { runFavoriteCommand, useChatFavorite } from "@/client/query/thread-user-state-commands";
import { useProjectChatFeed } from "@/client/query/useProjectChatFeed";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { useRenameThread } from "@/client/query/useRenameThread";
import { useWorks } from "@/client/query/useWorks";
import { announce, announceError } from "@/client/stores";
import { AskOnce } from "@/components/app/AskOnce";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { DropdownMenuItem, useMenuActionDispatch } from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { ListRow } from "@/components/ui/list-row";
import { OverflowMenu } from "@/components/ui/overflow-menu";
import { role } from "@/components/ui/roles";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import { lastInputWasKeyboard, moveFocus } from "@/lib/focus-follow";
import { displayThreadTitle } from "@/lib/thread-title";
import { cn } from "@/lib/utils";
import { RowIcon } from "../../context/ContextTreeRows";
import { PaneHeaderActionButton } from "../../context/RailPaneHeader";
import { SettledSearchField } from "../../SearchField";
import { TitleEditSlot } from "../TitleEditSlot";
import { useChatDeleteState } from "./ChatDeleteProvider";
import type { ChatDeleteNotice, ChatDeleteRefusal, ChatDeletes } from "./chat-deletes";
import { groupChats, type RowState } from "./chat-groups";
import { SourceHint, SourcePane } from "./SourcePane";

type Feed = ReturnType<typeof useProjectChatFeed>;

/** What every chat row needs from its list. */
type RowContext = {
  projectId: string;
  currentThreadId: string | null;
  states: ReadonlyMap<string, RowState>;
  replying: ReadonlySet<string>;
  deletes: ChatDeletes;
  refused: ChatDeleteRefusal | null;
  touch: boolean;
  onOpenChat: (threadId: string) => void;
};

/**
 * The Chat list: a find field over every chat, the writer's Favourites, the scoped Work's chats
 * by what they need from the writer, then All chats, newest first and paged. Working helpers sit
 * under their parent. Other Works keep one row each while one of their chats needs the writer or
 * is running. Each chat row opens, renames, favourites and deletes its chat; a delete has an Undo.
 */
export function ChatsBody({
  projectId,
  scopeWorkId,
  noWorkId,
  currentThreadId,
  onOpenChat,
  onNewChat,
  onShowWork,
  footer,
}: {
  projectId: string;
  scopeWorkId: string | null;
  noWorkId: string | null;
  currentThreadId: string | null;
  onOpenChat: (threadId: string) => void;
  onNewChat: () => void;
  onShowWork: (workId: string) => void;
  footer?: ReactNode;
}) {
  const { threads } = useProjectThreads(projectId);
  const { works } = useWorks(projectId);
  const [search, setSearch] = useState<string | null>(null);
  const [allOpen, setAllOpen] = useState(false);
  const { deletes, notice, refused } = useChatDeleteState();
  const touch = useCoarsePointer();
  const root = useRef<HTMLDivElement>(null);
  const favoriteFeed = useProjectChatFeed(projectId, true);
  // Every favourite loads, so no chat beyond the first page offers "Add to Favourites".
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = favoriteFeed;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isFetchNextPageError) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);
  const groups = useMemo(
    () => groupChats(threads ?? [], scopeWorkId ?? noWorkId, noWorkId, currentThreadId),
    [threads, scopeWorkId, noWorkId, currentThreadId],
  );
  const workName = (workId: string) =>
    workId === noWorkId
      ? t`Chats without a Work`
      : (works?.find((work) => work.id === workId)?.name ?? "");
  const rows: RowContext = {
    projectId,
    currentThreadId,
    states: groups.states,
    replying: groups.replying,
    deletes,
    refused,
    touch,
    onOpenChat,
  };
  // After Undo, focus goes to the chat's row, or to Find when no list here shows it.
  const focusChat = (threadId: string) => {
    const row = root.current?.querySelector<HTMLElement>(
      `[data-chat-id="${CSS.escape(threadId)}"] [data-list-item]`,
    );
    const target = row ?? root.current?.querySelector<HTMLElement>("input");
    if (target) moveFocus(target, { ring: lastInputWasKeyboard() });
  };

  const scoped = (thread: ThreadListItem) => (
    <div key={thread.id}>
      <ChatRow {...rows} chat={thread} />
      {groups.helpers.get(thread.id)?.map((helper) => (
        <ChatRow key={helper.id} {...rows} chat={helper} state="running" nested />
      ))}
    </div>
  );

  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col">
      <SourcePane
        label={t`Chats`}
        actions={<PaneHeaderActionButton icon={Plus} label={t`New chat`} onClick={onNewChat} />}
      >
        <div className="px-2 pt-1 pb-1">
          <SettledSearchField label={t`Find a chat`} value={search} onSettle={setSearch} />
        </div>
        {notice ? (
          <DeletedLine
            key={notice.id}
            notice={notice}
            takeFocus={() => deletes.takeFocus(notice.id)}
            onUndo={() =>
              void deletes.undo().then((restored) => restored && focusChat(notice.threadId))
            }
            onDismiss={deletes.dismiss}
          />
        ) : null}
        {search ? (
          <Group label={t`Results`}>
            <SearchResults search={search} rows={rows} />
          </Group>
        ) : threads === null ? (
          <SourceHint status>
            <Trans>Loading…</Trans>
          </SourceHint>
        ) : (
          <>
            {favoriteFeed.items.length > 0 ? (
              <Group label={t`Favourites`}>
                <FeedRows feed={favoriteFeed} rows={rows} empty={null} />
              </Group>
            ) : null}
            {/* One list, most urgent first; the mark on a row says its state. */}
            <div className="px-2 pt-1">
              {groups.needsYou.map(scoped)}
              {groups.running.map(scoped)}
              {groups.idle.map(scoped)}
            </div>
            {groups.needsYou.length + groups.running.length + groups.idle.length === 0 ? (
              <SourceHint>
                <Trans>No chats in this Work yet.</Trans>
              </SourceHint>
            ) : null}
            <Group label={t`Other Works`} hidden={groups.otherWorks.length === 0}>
              {groups.otherWorks.map((other) => (
                <ListRow
                  key={other.workId}
                  onOpen={() => onShowWork(other.workId)}
                  leading={<RowIcon icon={Layers} />}
                  title={workName(other.workId)}
                  meta={
                    other.needsYou > 0 ? (
                      <span className="text-jade-text">
                        <Trans>{other.needsYou} waiting on you</Trans>
                      </span>
                    ) : (
                      <Trans>{other.running} working</Trans>
                    )
                  }
                />
              ))}
            </Group>
            <div className="px-2 pt-2">
              <ListRow
                onOpen={() => setAllOpen((open) => !open)}
                controlProps={{ "aria-expanded": allOpen }}
                leading={<RowIcon icon={allOpen ? ChevronDown : ChevronRight} />}
                title={
                  <span className={role.secondary}>
                    <Trans>All chats</Trans>
                  </span>
                }
              />
              {allOpen ? <AllChats rows={rows} /> : null}
            </div>
          </>
        )}
      </SourcePane>
      {footer}
    </div>
  );
}

/** Every chat in the project, newest first: loaded only once opened, a page at a time. */
function AllChats({ rows }: { rows: RowContext }) {
  const feed = useProjectChatFeed(rows.projectId);
  return <FeedRows feed={feed} rows={rows} empty={<Trans>No chats yet.</Trans>} />;
}

/** The server's search over every chat's title, paged like All chats. */
function SearchResults({ search, rows }: { search: string; rows: RowContext }) {
  const feed = useProjectChatFeed(rows.projectId, false, search);
  return <FeedRows feed={feed} rows={rows} empty={<Trans>No chats match “{search}”.</Trans>} />;
}

/** A paged feed's rows, its Show more row, and its quiet failures. */
function FeedRows({ feed, rows, empty }: { feed: Feed; rows: RowContext; empty: ReactNode }) {
  if (feed.isPending)
    return (
      <SourceHint status>
        <Trans>Loading…</Trans>
      </SourceHint>
    );
  if (feed.isError && !feed.data)
    return (
      <InlineErrorRow
        message={<Trans>Couldn't load chats.</Trans>}
        onRetry={() => void feed.refetch()}
      />
    );
  if (!feed.items.length && !feed.hasNextPage && !feed.isPlaceholderData)
    return empty ? <SourceHint>{empty}</SourceHint> : null;
  return (
    <div aria-busy={feed.isFetching || undefined}>
      {feed.items.map((item) => (
        <ChatRow key={item.id} {...rows} chat={item} />
      ))}
      {feed.isFetchNextPageError ? (
        <InlineErrorRow
          message={<Trans>More chats couldn't load.</Trans>}
          onRetry={() => void feed.fetchNextPage()}
        />
      ) : feed.hasNextPage ? (
        <ListRow
          onOpen={() => void feed.fetchNextPage()}
          disabled={feed.isFetchingNextPage}
          title={
            <span className={role.secondary}>
              {feed.isFetchingNextPage ? <Trans>Loading more…</Trans> : <Trans>Show more</Trans>}
            </span>
          }
        />
      ) : null}
    </div>
  );
}

/**
 * The chat the writer just deleted, with its Undo. Focus moves to Undo when the delete makes it,
 * not when the list remounts with it already showing.
 */
function DeletedLine({
  notice,
  takeFocus,
  onUndo,
  onDismiss,
}: {
  notice: ChatDeleteNotice;
  /** True once per notice: the delete just made it. */
  takeFocus: () => boolean;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  const undo = useRef<HTMLButtonElement>(null);
  const latest = useRef(takeFocus);
  useEffect(() => {
    if (latest.current() && undo.current) moveFocus(undo.current, { ring: lastInputWasKeyboard() });
  }, []);
  if (notice.status === "failed")
    return (
      <div className="px-2 pb-1">
        <InlineErrorRow
          message={t`Couldn't restore ${notice.title}`}
          onRetry={onUndo}
          onDismiss={onDismiss}
        />
      </div>
    );
  return (
    <div
      className="flex min-w-0 items-center gap-2 px-3.5 pb-1 text-xs"
      role="status"
      data-chat-delete-notice
    >
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        <Trans>Deleted {notice.title}</Trans>
      </span>
      <button
        ref={undo}
        type="button"
        className="text-button text-xs coarse:min-h-11"
        onClick={onUndo}
        disabled={notice.status === "restoring"}
      >
        <Trans>Undo</Trans>
      </button>
      <button type="button" className="text-button text-xs coarse:min-h-11" onClick={onDismiss}>
        <Trans>Dismiss</Trans>
      </button>
    </div>
  );
}

function Group({
  label,
  hidden = false,
  children,
}: {
  label: string;
  hidden?: boolean;
  children: ReactNode;
}) {
  if (hidden) return null;
  return (
    <section aria-label={label} className="px-2 pt-2">
      <h3 className={cn("px-1.5 pb-1", role.groupLabel)}>{label}</h3>
      {children}
    </section>
  );
}

/** A chat as either list names it: the thread list's row or a feed page's. */
type RowChat = { id: string; title: string | null; agentName: string | null };

function ChatRow({
  projectId,
  chat,
  state = "idle",
  currentThreadId,
  states,
  replying,
  deletes,
  refused,
  touch,
  nested = false,
  onOpenChat,
}: RowContext & { chat: RowChat; state?: RowState; nested?: boolean }) {
  const client = useQueryClient();
  const title = displayThreadTitle(chat.title);
  const favorite = useChatFavorite(projectId, chat.id);
  const [menuOpen, setMenuOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const { dispatch, onCloseAutoFocus } = useMenuActionDispatch();
  const rename = useRenameThread(projectId, chat.id, (confirmed) => {
    announce(t`Renamed to ${confirmed}`);
  });
  const shownState = states.get(chat.id) ?? state;
  const onFavorite = (value: boolean) =>
    void runFavoriteCommand(client, projectId, chat.id, value).then((outcome) => {
      if (outcome.status !== "success") announceError(t`Favorite wasn’t saved`);
      else announce(value ? t`${title} added to Favorites` : t`${title} removed from Favorites`);
    });
  // The server stops a running reply in the delete, and Undo can't restart it: that delete asks.
  const onDelete = () => (replying.has(chat.id) ? setAsking(true) : deletes.delete(chat.id, title));
  return (
    <div data-chat-id={chat.id}>
      <TitleEditSlot
        titleKey={`chat:${chat.id}`}
        label={t`Rename chat`}
        failure={() => t`Couldn’t rename this chat. Try again.`}
        rename={rename}
        maxLength={THREAD_TITLE_MAX_LENGTH}
        fieldClassName="h-7 px-1.5 text-sm"
      >
        {({ start, triggerRef }) => (
          <ListRow
            ref={triggerRef}
            onOpen={() => onOpenChat(chat.id)}
            current={chat.id === currentThreadId ? "page" : false}
            depth={nested ? 1 : 0}
            revealActions={!touch && !menuOpen}
            leading={
              chat.agentName ? (
                <span
                  aria-hidden
                  className={cn(
                    "grid size-4 shrink-0 place-items-center rounded-sm border border-border-subtle font-medium leading-none",
                    role.rowSecondary,
                  )}
                  title={chat.agentName}
                >
                  {chat.agentName.slice(0, 1).toUpperCase()}
                </span>
              ) : null
            }
            title={title}
            trailing={shownState === "idle" ? null : <StateMark state={shownState} />}
            actions={
              <>
                {favorite ? (
                  <IconButton
                    size="sm"
                    aria-pressed
                    label={t`Remove ${title} from Favourites`}
                    onClick={() => onFavorite(false)}
                    className="text-gold hover:text-gold"
                  >
                    <Star aria-hidden className="size-3.5 fill-current" />
                  </IconButton>
                ) : null}
                <OverflowMenu
                  open={menuOpen}
                  onOpenChange={setMenuOpen}
                  onCloseAutoFocus={onCloseAutoFocus}
                  label={t`Actions for ${title}`}
                >
                  <DropdownMenuItem onSelect={() => dispatch(() => start(title))}>
                    <span>{t`Rename`}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onFavorite(!favorite)}>
                    <span>{favorite ? t`Remove from Favourites` : t`Add to Favourites`}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onSelect={() => dispatch(onDelete)}>
                    <span>{t`Delete chat`}</span>
                  </DropdownMenuItem>
                </OverflowMenu>
              </>
            }
            below={
              asking ? (
                <AskOnce
                  className="px-1.5 pb-1"
                  touch={touch}
                  sentence={t`Delete this chat? Its reply is still running and will stop.`}
                  keep={t`Keep`}
                  confirm={t`Delete`}
                  onKeep={() => setAsking(false)}
                  onConfirm={() => {
                    setAsking(false);
                    deletes.delete(chat.id, title);
                  }}
                />
              ) : refused?.threadId === chat.id ? (
                <InlineErrorRow
                  message={t`Couldn't delete this chat`}
                  onRetry={() => deletes.delete(chat.id, title)}
                />
              ) : null
            }
          />
        )}
      </TitleEditSlot>
    </div>
  );
}

function StateMark({ state }: { state: Exclude<RowState, "idle"> }) {
  if (state === "running")
    return (
      <span
        role="img"
        aria-label={t`Working`}
        className="size-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-border-subtle border-t-muted-foreground motion-reduce:animate-none"
      />
    );
  return (
    <span
      role="img"
      aria-label={t`Waiting on you`}
      className="size-2 shrink-0 rounded-full bg-primary"
    />
  );
}
