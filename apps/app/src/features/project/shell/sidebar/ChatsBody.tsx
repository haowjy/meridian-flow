import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { THREAD_TITLE_MAX_LENGTH, type ThreadListItem } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { Pin, Plus } from "lucide-react";
import { memo, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { runFavoriteCommand, usePinnedChatIds } from "@/client/query/thread-user-state-commands";
import { useProjectChatFeed } from "@/client/query/useProjectChatFeed";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { useRenameThread } from "@/client/query/useRenameThread";
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
/** Other chats shown at first, and added by each Show more. */
const OTHERS_PAGE = 20;

/** What every chat row shares; stable across renders, so a row re-renders only for its own chat. */
type RowContext = {
  projectId: string;
  deletes: ChatDeletes;
  refused: ChatDeleteRefusal | null;
  touch: boolean;
  onOpenChat: (threadId: string) => void;
  /** The chat's row moved to another list (pinned, unpinned) and should keep focus. */
  onMoved: (threadId: string, pinned: boolean) => void;
};

/**
 * The Chat list: a find field over every chat; the scoped Work's chats, pinned first, under no
 * heading; then Other chats, folded, the other Works' pinned chats first, shown a page at a time.
 * Each chat shows once, in its own Work's list, and opening it doesn't move it; while Other chats
 * is folded, the open chat in it shows under its heading. Working helpers sit under their parent.
 * Each chat row opens, renames, pins and deletes its chat; a delete has an Undo. The API calls a
 * pin `favorite`.
 */
export function ChatsBody({
  projectId,
  scopeWorkId,
  noWorkId,
  currentThreadId,
  onOpenChat,
  onNewChat,
  footer,
}: {
  projectId: string;
  scopeWorkId: string | null;
  noWorkId: string | null;
  currentThreadId: string | null;
  onOpenChat: (threadId: string) => void;
  onNewChat: () => void;
  footer?: ReactNode;
}) {
  const { threads } = useProjectThreads(projectId);
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
  const othersFold = useSectionFold(projectId, "chats", "others", false);
  // Every pin loads, so no chat beyond the first page offers "Pin".
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = favoriteFeed;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isFetchNextPageError) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);
  const groups = useMemo(
    () => groupChats(threads ?? [], scopeWorkId ?? noWorkId, noWorkId, pinnedIds),
    [threads, scopeWorkId, noWorkId, pinnedIds],
  );
  const openChat = useRef(onOpenChat);
  openChat.current = onOpenChat;
  const ctx = useMemo<RowContext>(
    () => ({
      projectId,
      deletes,
      refused,
      touch,
      onOpenChat: (id) => openChat.current(id),
      onMoved: (id, pinned) => {
        const active = document.activeElement;
        if (active === document.body || active?.closest(chatSelector(id))) {
          setFocusRow({ id, pinned });
        }
      },
    }),
    [projectId, deletes, refused, touch],
  );
  const row = (chat: RowChat, nested = false) => (
    <ChatRow
      key={chat.id}
      ctx={ctx}
      chat={chat}
      state={groups.states.get(chat.id) ?? (nested ? "running" : "idle")}
      replying={groups.replying.has(chat.id)}
      pinned={pinnedIds.has(chat.id)}
      current={chat.id === currentThreadId}
      nested={nested}
    />
  );
  const [othersShown, setOthersShown] = useState(OTHERS_PAGE);
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

  const scopeEmpty = groups.scoped.length === 0 && groups.pinned.length === 0;
  const withHelpers = (thread: ThreadListItem) => (
    <div key={thread.id}>
      {row(thread)}
      {groups.helpers.get(thread.id)?.map((helper) => row(helper, true))}
    </div>
  );
  const others = [...groups.othersPinned, ...groups.others];
  const shownOthers = others.slice(0, othersShown);
  // The open chat shows wherever it sits in Other chats, past the page or under the folded heading.
  const openOther = others.find((chat) => chat.id === currentThreadId) ?? null;
  const openPastPage = openOther !== null && !shownOthers.includes(openOther);
  const pinnedShown = shownOthers.filter((chat) => pinnedIds.has(chat.id));

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
          <section aria-label={t`Results`} className="px-2 pt-2">
            <SearchResults projectId={projectId} search={search} row={row} />
          </section>
        ) : threads === null ? (
          <div className="px-2">
            <ListLine status>
              <Trans>Loading…</Trans>
            </ListLine>
          </div>
        ) : (
          <>
            <div className="px-2 pt-1">
              {groups.pinned.length > 0 ? (
                <div data-pinned-list>{groups.pinned.map(withHelpers)}</div>
              ) : null}
              {groups.scoped.map(withHelpers)}
              {scopeEmpty ? (
                <ListLine>
                  <Trans>No chats here yet.</Trans>
                </ListLine>
              ) : null}
            </div>
            {others.length > 0 ? (
              <ListSection
                label={t`Other chats`}
                fold={othersFold}
                foldedMark={
                  groups.othersState === "idle" ? null : <StateMark state={groups.othersState} />
                }
              >
                {pinnedShown.length > 0 ? (
                  <div data-pinned-list>{pinnedShown.map(withHelpers)}</div>
                ) : null}
                {shownOthers.slice(pinnedShown.length).map(withHelpers)}
                {openPastPage ? withHelpers(openOther) : null}
                {others.length > othersShown ? (
                  <ListRow
                    onOpen={() => setOthersShown((shown) => shown + OTHERS_PAGE)}
                    title={
                      <span className={role.secondary}>
                        <Trans>Show more</Trans>
                      </span>
                    }
                  />
                ) : null}
              </ListSection>
            ) : null}
            {openOther && !othersFold.open ? (
              <div className="px-2">{withHelpers(openOther)}</div>
            ) : null}
          </>
        )}
      </SourcePane>
      {footer}
    </div>
  );
}

/** The server's search over every chat's title, paged. */
function SearchResults({
  projectId,
  search,
  row,
}: {
  projectId: string;
  search: string;
  row: (chat: RowChat) => ReactNode;
}) {
  const feed = useProjectChatFeed(projectId, false, search);
  return <FeedRows feed={feed} row={row} empty={<Trans>No chats match “{search}”.</Trans>} />;
}

/** A paged feed's rows, its Show more row, and its quiet failures. */
function FeedRows({
  feed,
  row,
  empty,
}: {
  feed: Feed;
  row: (chat: RowChat) => ReactNode;
  empty: ReactNode;
}) {
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
      {feed.items.map((item) => row(item))}
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

const ChatRow = memo(function ChatRow({
  ctx: { projectId, deletes, refused, touch, onOpenChat, onMoved },
  chat,
  state,
  replying,
  pinned,
  current,
  nested,
}: {
  ctx: RowContext;
  chat: RowChat;
  state: RowState;
  replying: boolean;
  pinned: boolean;
  current: boolean;
  nested: boolean;
}) {
  const client = useQueryClient();
  const title = displayThreadTitle(chat.title);
  const [menuOpen, setMenuOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const { dispatch, onCloseAutoFocus } = useMenuActionDispatch();
  const rename = useRenameThread(projectId, chat.id, (confirmed) => {
    announce(t`Renamed to ${confirmed}`);
  });
  const onPin = (value: boolean) =>
    void runFavoriteCommand(client, projectId, chat.id, value).then((outcome) => {
      if (outcome.status !== "success") {
        announceError(value ? t`Couldn’t pin ${title}` : t`Couldn’t unpin ${title}`);
        onMoved(chat.id, !value);
      } else announce(value ? t`Pinned ${title}` : t`Unpinned ${title}`);
    });
  // The server stops a running reply in the delete, and Undo can't restart it: that delete asks.
  const onDelete = () => (replying ? setAsking(true) : deletes.delete(chat.id, title));
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
            current={current ? "page" : false}
            depth={nested ? 1 : 0}
            revealActions={!touch && !menuOpen}
            icon={pinned ? Pin : undefined}
            title={title}
            trailing={state === "idle" ? null : <StateMark state={state} />}
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
});

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
