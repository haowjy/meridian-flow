import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { THREAD_TITLE_MAX_LENGTH, type ThreadListItem } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { Pin } from "lucide-react";
import { memo, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { runFavoriteCommand } from "@/client/query/thread-user-state-commands";
import { useProjectChatFeed } from "@/client/query/useProjectChatFeed";
import { useRenameThread } from "@/client/query/useRenameThread";
import { announce, announceError } from "@/client/stores";
import { AskOnce } from "@/components/app/AskOnce";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { RowWord, withGone } from "@/components/app/RowWord";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem, useMenuActionDispatch } from "@/components/ui/dropdown-menu";
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
import type { ChatDeleteNotice, ChatDeleteRefusal, ChatDeletes, ChatPlace } from "./chat-deletes";
import type { RowState } from "./chat-groups";
import { SourcePane } from "./SourcePane";
import { useChatGroups } from "./use-chat-groups";

type Feed = ReturnType<typeof useProjectChatFeed>;
const chatSelector = (id: string) => `[data-chat-id="${CSS.escape(id)}"]`;

/** Where the chat's row is now: its list and the chats above it there. */
function placeOf(id: string): ChatPlace | null {
  const row = document.querySelector(chatSelector(id));
  const list = row?.closest<HTMLElement>("[data-chat-list]");
  const key = list?.dataset.chatList;
  if (!row || !list || !key) return null;
  const ids = [...list.querySelectorAll<HTMLElement>("[data-chat-id]")].map(
    (each) => each.dataset.chatId ?? "",
  );
  return { list: key, after: ids.slice(0, ids.indexOf(id)).reverse() };
}

/** Unpinned chats a list shows at first, and adds with each Show more. */
const PAGE = 20;

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
}: {
  projectId: string;
  scopeWorkId: string | null;
  noWorkId: string | null;
  currentThreadId: string | null;
  onOpenChat: (threadId: string) => void;
  onNewChat: () => void;
}) {
  const {
    threads,
    groups,
    pinnedIds,
    settled: listsSettled,
  } = useChatGroups(projectId, scopeWorkId, noWorkId);
  const [search, setSearch] = useState<string | null>(null);
  const { deletes, notice, refused } = useChatDeleteState();
  const touch = useCoarsePointer();
  const root = useRef<HTMLDivElement>(null);
  const othersFold = useSectionFold(projectId, "chats", "others", false);
  const openChat = useRef(onOpenChat);
  openChat.current = onOpenChat;
  const ctx = useMemo<RowContext>(
    () => ({
      projectId,
      deletes,
      refused,
      touch,
      // Opening a chat is the writer's next action here: a delete's Undo ends with it.
      onOpenChat: (id) => {
        deletes.dismiss();
        openChat.current(id);
      },
      onMoved: (id, pinned) => {
        const active = document.activeElement;
        if (active === document.body || active?.closest(chatSelector(id))) {
          setFocusRow({ id, pinned });
        }
      },
    }),
    [projectId, deletes, refused, touch],
  );
  const undo = () => {
    if (!notice) return;
    void deletes.undo().then((restored) => {
      if (restored) setFocusRow({ id: notice.threadId });
    });
  };
  // The chat just deleted stays in its place, struck through, with its Undo.
  const deleted: DeletedChat = notice
    ? {
        notice,
        row: () => (
          <DeletedRow
            key={notice.id}
            notice={notice}
            takeFocus={() => deletes.takeFocus(notice.id)}
            onUndo={undo}
          />
        ),
      }
    : null;
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
  const [focusRow, setFocusRow] = useState<{ id: string; pinned?: boolean } | null>(null);
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

  const withHelpers = (thread: ThreadListItem) => (
    <div key={thread.id}>
      {row(thread)}
      {groups.helpers.get(thread.id)?.map((helper) => row(helper, true))}
    </div>
  );
  const othersCount = groups.othersPinned.length + groups.others.length;
  // While Other chats is folded, the open chat in it shows under its heading.
  const openOther =
    [...groups.othersPinned, ...groups.others].find((chat) => chat.id === currentThreadId) ?? null;

  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col">
      <SourcePane
        label={t`Chats`}
        search={<SettledSearchField label={t`Find a chat`} value={search} onSettle={setSearch} />}
        actions={
          <Button
            variant="quiet"
            size="xs"
            onClick={() => {
              deletes.dismiss();
              onNewChat();
            }}
          >
            <Trans>New chat</Trans>
          </Button>
        }
      >
        {search ? (
          <section aria-label={t`Results`} className="px-2 pt-2">
            <SearchResults projectId={projectId} search={search} row={row} deleted={deleted} />
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
              <PagedChats
                key={scopeWorkId ?? noWorkId}
                pinned={groups.pinned}
                chats={groups.scoped}
                openId={currentThreadId}
                render={withHelpers}
                deleted={deleted}
                list={`${projectId}:scoped`}
                empty={<Trans>No chats here yet.</Trans>}
              />
            </div>
            {othersCount > 0 ? (
              <ListSection
                label={t`Other chats`}
                fold={othersFold}
                foldedMark={
                  groups.othersState === "idle" ? null : <StateMark state={groups.othersState} />
                }
              >
                <PagedChats
                  key={scopeWorkId ?? noWorkId}
                  pinned={groups.othersPinned}
                  chats={groups.others}
                  openId={currentThreadId}
                  render={withHelpers}
                  deleted={deleted}
                  list={`${projectId}:others`}
                />
              </ListSection>
            ) : null}
            {openOther && !othersFold.open ? (
              <div className="px-2">{withHelpers(openOther)}</div>
            ) : null}
          </>
        )}
      </SourcePane>
    </div>
  );
}

/** The chat whose delete is showing: its row stays where it was, struck through. */
type DeletedChat = { notice: ChatDeleteNotice; row: () => ReactNode } | null;

/** A list's chats with the deleted one kept where it was, in the list it was in. */
function withDeleted<T extends RowChat>(
  list: string,
  chats: readonly T[],
  deleted: DeletedChat,
  render: (chat: T) => ReactNode,
): ReactNode[] {
  const place = deleted?.notice.place;
  const gone =
    deleted && place?.list === list
      ? [{ key: deleted.notice.threadId, row: deleted, after: place.after }]
      : [];
  return withGone(chats, chatKey, gone).map((item) =>
    item.gone ? item.row.row() : render(item.row),
  );
}

const chatKey = (chat: RowChat) => chat.id;

/**
 * A list's pinned chats, then its other chats a page at a time with Show more; the open chat
 * shows even past the page. Show more moves focus to the first chat it adds.
 */
function PagedChats({
  list: listKey,
  pinned,
  chats,
  openId,
  render,
  deleted,
  empty,
}: {
  pinned: readonly ThreadListItem[];
  chats: readonly ThreadListItem[];
  openId: string | null;
  render: (chat: ThreadListItem) => ReactNode;
  deleted: DeletedChat;
  /** Which list (this Work's or Other chats), so a deleted chat keeps its place there. */
  list: string;
  /** Said when the list draws no row, a deleted chat it still holds included. */
  empty?: ReactNode;
}) {
  const [shown, setShown] = useState(PAGE);
  const list = useRef<HTMLDivElement>(null);
  const focusFrom = useRef<number | null>(null);
  useEffect(() => {
    const from = focusFrom.current;
    if (from === null) return;
    focusFrom.current = null;
    const added = list.current?.querySelectorAll<HTMLElement>(":scope > [data-paged-chat]")[from];
    const control = added?.querySelector<HTMLElement>("[data-list-item]");
    if (control) moveFocus(control, { ring: lastInputWasKeyboard() });
  }, [shown]);
  const page = chats.slice(0, shown);
  const open = chats.find((chat) => chat.id === openId);
  const openPastPage = open !== undefined && !page.includes(open);
  const pinnedKey = `chats:${listKey}:pinned`;
  const pageKey = `chats:${listKey}`;
  const pinnedRows = withDeleted(pinnedKey, pinned, deleted, render);
  const pageRows = withDeleted(pageKey, page, deleted, (chat) => (
    <div key={chat.id} data-paged-chat>
      {render(chat)}
    </div>
  ));
  return (
    <>
      {pinnedRows.length > 0 ? (
        <div data-pinned-list data-chat-list={pinnedKey}>
          {pinnedRows}
        </div>
      ) : null}
      <div ref={list} data-chat-list={pageKey}>
        {pageRows}
        {openPastPage ? render(open) : null}
      </div>
      {empty && pinnedRows.length === 0 && pageRows.length === 0 && !openPastPage ? (
        <ListLine>{empty}</ListLine>
      ) : null}
      {chats.length > shown ? (
        <ListRow
          onOpen={() => {
            focusFrom.current = shown;
            setShown(shown + PAGE);
          }}
          title={
            <span className={role.secondary}>
              <Trans>Show more</Trans>
            </span>
          }
        />
      ) : null}
    </>
  );
}

/** The server's search over every chat's title, paged. */
function SearchResults({
  projectId,
  search,
  row,
  deleted,
}: {
  projectId: string;
  search: string;
  row: (chat: RowChat) => ReactNode;
  deleted: DeletedChat;
}) {
  const feed = useProjectChatFeed(projectId, false, search);
  return (
    <FeedRows
      feed={feed}
      row={row}
      deleted={deleted}
      empty={<Trans>No chats match “{search}”.</Trans>}
    />
  );
}

/** A paged feed's rows, its Show more row, and its quiet failures. */
function FeedRows({
  feed,
  row,
  deleted,
  empty,
}: {
  feed: Feed;
  row: (chat: RowChat) => ReactNode;
  deleted: DeletedChat;
  empty: ReactNode;
}) {
  const rows = withDeleted("chats:search", feed.items, deleted, row);
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
  if (!rows.length && !feed.hasNextPage && !feed.isPlaceholderData)
    return empty ? <ListLine>{empty}</ListLine> : null;
  return (
    <div aria-busy={feed.isFetching || undefined} data-chat-list="chats:search">
      {rows}
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
 * The chat the writer just deleted, struck through in its place with its Undo. Focus moves to
 * Undo when the delete makes it, not when the list remounts with it already showing.
 */
function DeletedRow({
  notice,
  takeFocus,
  onUndo,
}: {
  notice: ChatDeleteNotice;
  /** True once per notice: the delete just made it. */
  takeFocus: () => boolean;
  onUndo: () => void;
}) {
  const { title } = notice;
  const failed = notice.status === "failed";
  return (
    <div data-chat-delete-notice={notice.threadId}>
      <ListRow
        gone
        title={title}
        notice={
          <RowWord
            focus={{ take: takeFocus }}
            word={failed ? <Trans>Retry</Trans> : <Trans>Undo</Trans>}
            tone={failed ? "warning" : "action"}
            label={failed ? t`Retry restoring ${title}` : t`Undo delete of ${title}`}
            sentence={failed ? t`Couldn't restore` : t`Deleted just now`}
            pending={notice.status === "restoring"}
            onAction={onUndo}
          />
        }
      />
    </div>
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
  const onDelete = () =>
    replying ? setAsking(true) : deletes.delete(chat.id, title, placeOf(chat.id));
  return (
    <div data-chat-id={chat.id}>
      <TitleEditSlot
        titleKey={`chat:${chat.id}`}
        label={t`Rename chat`}
        failure={() => t`Couldn't rename this chat`}
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
            notice={
              refused?.threadId === chat.id ? (
                <RowWord
                  tone="warning"
                  word={<Trans>Retry</Trans>}
                  label={t`Retry deleting ${title}`}
                  sentence={t`Couldn't delete`}
                  onAction={() => deletes.delete(chat.id, title, placeOf(chat.id))}
                />
              ) : null
            }
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
                  sentence={t`Stop and delete?`}
                  keep={t`Keep`}
                  confirm={t`Delete`}
                  returnFocus={() =>
                    document.querySelector<HTMLElement>(`${chatSelector(chat.id)} [data-list-item]`)
                  }
                  onKeep={() => setAsking(false)}
                  onConfirm={() => {
                    setAsking(false);
                    deletes.delete(chat.id, title, placeOf(chat.id));
                  }}
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
