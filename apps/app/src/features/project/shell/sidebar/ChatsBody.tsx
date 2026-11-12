import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { THREAD_TITLE_MAX_LENGTH, type ThreadListItem } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { Layers, Plus } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { runFavoriteCommand, usePinnedChatIds } from "@/client/query/thread-user-state-commands";
import { useProjectChatFeed } from "@/client/query/useProjectChatFeed";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { useRenameThread } from "@/client/query/useRenameThread";
import { useWorks } from "@/client/query/useWorks";
import { announce, announceError } from "@/client/stores";
import { ActionNotice } from "@/components/app/ActionNotice";
import { AskOnce } from "@/components/app/AskOnce";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { DropdownMenuItem, useMenuActionDispatch } from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { ListLine, ListRow } from "@/components/ui/list-row";
import { ListSection } from "@/components/ui/list-section";
import { OverflowMenu } from "@/components/ui/overflow-menu";
import { role } from "@/components/ui/roles";
import { SettledSearchField } from "@/components/ui/search-field";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import { lastInputWasKeyboard, moveFocus } from "@/lib/focus-follow";
import { displayThreadTitle } from "@/lib/thread-title";
import { useSectionFold } from "../../context/use-tree-expansion";
import { TitleEditSlot } from "../TitleEditSlot";
import { useChatDeleteState } from "./ChatDeleteProvider";
import type { ChatDeleteNotice, ChatDeleteRefusal, ChatDeletes } from "./chat-deletes";
import { groupChats, type RowState } from "./chat-groups";
import { SourcePane } from "./SourcePane";

type Feed = ReturnType<typeof useProjectChatFeed>;
const chatSelector = (id: string) => `[data-chat-id="${CSS.escape(id)}"]`;

/** What every chat row needs from its list. */
type RowContext = {
  projectId: string;
  currentThreadId: string | null;
  states: ReadonlyMap<string, RowState>;
  replying: ReadonlySet<string>;
  pinnedIds: ReadonlySet<string>;
  deletes: ChatDeletes;
  refused: ChatDeleteRefusal | null;
  touch: boolean;
  onOpenChat: (threadId: string) => void;
  /** The chat's row moved to another list (pinned, unpinned) and should keep focus. */
  onMoved: (threadId: string, pinned: boolean) => void;
};

/**
 * The Chat list: a find field over every chat, the writer's Pinned chats (foldable), the scoped
 * Work's other chats by what they need from the writer, then All chats, newest first and paged.
 * Working helpers sit under their parent. Other Works keep one row each while one of their chats
 * needs the writer or is running. Each chat row opens, renames, pins and deletes its chat; a
 * delete has an Undo. The API calls a pin `favorite`.
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
  const { deletes, notice, refused } = useChatDeleteState();
  const touch = useCoarsePointer();
  const root = useRef<HTMLDivElement>(null);
  const favoriteFeed = useProjectChatFeed(projectId, true);
  const confirmedPins = useMemo(
    () => favoriteFeed.items.map((item) => item.id),
    [favoriteFeed.items],
  );
  const pinnedIds = usePinnedChatIds(projectId, confirmedPins, favoriteFeed.dataUpdatedAt);
  const pinnedFold = useSectionFold(projectId, "chats", "pinned");
  // All chats loads only once opened.
  const allFold = useSectionFold(projectId, "chats", "all", false);
  // Every pin loads, so no chat beyond the first page offers "Pin".
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = favoriteFeed;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isFetchNextPageError) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);
  const groups = useMemo(
    () => groupChats(threads ?? [], scopeWorkId ?? noWorkId, noWorkId, currentThreadId, pinnedIds),
    [threads, scopeWorkId, noWorkId, currentThreadId, pinnedIds],
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
    pinnedIds,
    deletes,
    refused,
    touch,
    onOpenChat,
    onMoved: (id, pinned) => {
      const active = document.activeElement;
      if (active === document.body || active?.closest(chatSelector(id))) {
        setFocusRow({ id, pinned });
      }
    },
  };
  // After Undo, Pin or Unpin, focus goes to the chat's row in its list, or to Find when no list
  // here shows it. The row mounts only once the lists have loaded (a restored pin past the first
  // page loads later), and a pinned or unpinned row only once it has moved, so focus waits for
  // that render rather than land on the row about to unmount. Focus the writer puts elsewhere
  // meanwhile ends the wait.
  const [focusRow, setFocusRow] = useState<{ id: string; pinned?: boolean } | null>(null);
  const listsSettled = threads !== null && !favoriteFeed.isFetching && !favoriteFeed.hasNextPage;
  useEffect(() => {
    if (!focusRow) return;
    const drop = (event: FocusEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(chatSelector(focusRow.id))) {
        setFocusRow(null);
      }
    };
    document.addEventListener("focusin", drop);
    return () => document.removeEventListener("focusin", drop);
  }, [focusRow]);
  useEffect(() => {
    if (!focusRow) return;
    const rows = [
      ...(root.current?.querySelectorAll<HTMLElement>(
        `${chatSelector(focusRow.id)} [data-list-item]`,
      ) ?? []),
    ];
    const row = rows.find(
      (item) =>
        focusRow.pinned === undefined ||
        (item.closest("[data-pinned-list]") !== null) === focusRow.pinned,
    );
    // Still in the list it is leaving: wait for the move.
    if (!row && (rows.length > 0 || !listsSettled)) return;
    setFocusRow(null);
    const target = row ?? root.current?.querySelector<HTMLElement>("input");
    if (target) moveFocus(target, { ring: lastInputWasKeyboard() });
  });

  // Each list most urgent first; the mark on a row says its state.
  const listed = [...groups.needsYou, ...groups.running, ...groups.idle];
  const scopeId = scopeWorkId ?? noWorkId;
  const scopeEmpty =
    listed.length === 0 && groups.pinned.every((chat) => (chat.workId ?? noWorkId) !== scopeId);
  const withHelpers = (thread: ThreadListItem) => (
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
        actions={
          <IconButton label={t`New chat`} onClick={onNewChat}>
            <Plus aria-hidden />
          </IconButton>
        }
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
              void deletes.undo().then((restored) => {
                if (restored) setFocusRow({ id: notice.threadId });
              })
            }
            onDismiss={deletes.dismiss}
          />
        ) : null}
        {search ? (
          <ListSection label={t`Results`}>
            <SearchResults search={search} rows={rows} />
          </ListSection>
        ) : threads === null ? (
          <div className="px-2">
            <ListLine status>
              <Trans>Loading…</Trans>
            </ListLine>
          </div>
        ) : (
          <>
            {groups.pinned.length > 0 ? (
              <ListSection
                label={t`Pinned`}
                fold={pinnedFold}
                foldedMark={
                  groups.pinnedState === "idle" ? null : <StateMark state={groups.pinnedState} />
                }
              >
                <div data-pinned-list>{groups.pinned.map(withHelpers)}</div>
              </ListSection>
            ) : null}
            {listed.length > 0 ? (
              <ListSection label={workName(scopeId ?? "")}>{listed.map(withHelpers)}</ListSection>
            ) : null}
            {scopeEmpty ? (
              <div className="px-2">
                <ListLine>
                  <Trans>No chats here yet.</Trans>
                </ListLine>
              </div>
            ) : null}
            {groups.otherWorks.length > 0 ? (
              <ListSection label={t`Other Works`}>
                {groups.otherWorks.map((other) => (
                  <ListRow
                    key={other.workId}
                    onOpen={() => onShowWork(other.workId)}
                    icon={Layers}
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
              </ListSection>
            ) : null}
            <ListSection label={t`All chats`} fold={allFold}>
              <AllChats rows={rows} />
            </ListSection>
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
      <ListLine status>
        <Trans>Loading…</Trans>
      </ListLine>
    );
  if (feed.isError && !feed.data)
    return (
      <InlineErrorRow
        message={<Trans>Couldn't load chats.</Trans>}
        onRetry={() => void feed.refetch()}
      />
    );
  if (!feed.items.length && !feed.hasNextPage && !feed.isPlaceholderData)
    return empty ? <ListLine>{empty}</ListLine> : null;
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
  const { title } = notice;
  return (
    <ActionNotice
      data-chat-delete-notice
      sentence={(title) => t`Deleted ${title}`}
      name={title}
      action={{
        label: <Trans>Undo</Trans>,
        onClick: onUndo,
        pending: notice.status === "restoring",
        ref: undo,
      }}
      onDismiss={onDismiss}
      failure={
        notice.status === "failed"
          ? { message: t`Couldn't restore ${title}`, onRetry: onUndo, onDismiss }
          : null
      }
      className="pl-3.5"
    />
  );
}

/** A chat as either list names it: the thread list's row or a feed page's. */
type RowChat = { id: string; title: string | null };

function ChatRow({
  projectId,
  chat,
  state = "idle",
  currentThreadId,
  states,
  replying,
  pinnedIds,
  deletes,
  refused,
  touch,
  nested = false,
  onOpenChat,
  onMoved,
}: RowContext & { chat: RowChat; state?: RowState; nested?: boolean }) {
  const client = useQueryClient();
  const title = displayThreadTitle(chat.title);
  const pinned = pinnedIds.has(chat.id);
  const [menuOpen, setMenuOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const { dispatch, onCloseAutoFocus } = useMenuActionDispatch();
  const rename = useRenameThread(projectId, chat.id, (confirmed) => {
    announce(t`Renamed to ${confirmed}`);
  });
  const shownState = states.get(chat.id) ?? state;
  const onPin = (value: boolean) =>
    void runFavoriteCommand(client, projectId, chat.id, value).then((outcome) => {
      if (outcome.status !== "success") {
        announceError(value ? t`Couldn’t pin ${title}` : t`Couldn’t unpin ${title}`);
        onMoved(chat.id, !value);
      } else announce(value ? t`Pinned ${title}` : t`Unpinned ${title}`);
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
            title={title}
            trailing={shownState === "idle" ? null : <StateMark state={shownState} />}
            actions={
              <OverflowMenu
                dense
                open={menuOpen}
                onOpenChange={setMenuOpen}
                onCloseAutoFocus={onCloseAutoFocus}
                label={t`Actions for ${title}`}
              >
                <DropdownMenuItem onSelect={() => dispatch(() => start(title))}>
                  <span>{t`Rename`}</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    dispatch(() => {
                      onPin(!pinned);
                      onMoved(chat.id, !pinned);
                    })
                  }
                >
                  <span>{pinned ? t`Unpin` : t`Pin`}</span>
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onSelect={() => dispatch(onDelete)}>
                  <span>{t`Delete chat`}</span>
                </DropdownMenuItem>
              </OverflowMenu>
            }
            below={
              asking ? (
                <AskOnce
                  className="px-1.5 pb-1"
                  touch={touch}
                  sentence={t`Delete this chat? Its reply is still running and will stop.`}
                  keep={t`Keep`}
                  confirm={t`Delete`}
                  returnFocus={() =>
                    document.querySelector<HTMLElement>(`${chatSelector(chat.id)} [data-list-item]`)
                  }
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
