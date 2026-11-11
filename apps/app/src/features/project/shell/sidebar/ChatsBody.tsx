import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ThreadListItem } from "@meridian/contracts/protocol";
import { Layers, Plus } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { useWorks } from "@/client/query/useWorks";
import { role } from "@/components/ui/roles";
import { displayThreadTitle } from "@/lib/thread-title";
import { cn } from "@/lib/utils";
import { RowIcon, rowPaddingLeft } from "../../context/ContextTreeRows";
import { contextTreeFileRowClassName } from "../../context/context-row-geometry";
import { PaneHeaderActionButton } from "../../context/RailPaneHeader";
import { SourceHint, SourcePane } from "./SourcePane";

/** Idle chats shown before "Older" hands over to the full list. */
const IDLE_SHOWN = 6;

type ChatGroups = {
  needsYou: ThreadListItem[];
  running: ThreadListItem[];
  idle: ThreadListItem[];
  older: number;
  helpers: Map<string, ThreadListItem[]>;
  otherWorks: { workId: string; running: number; needsYou: number }[];
};

/**
 * Chat mode's sidebar: the scoped Work's chats by what they need from the
 * writer. Working helpers sit under their parent. Other Works keep one row each
 * while one of their chats needs the writer or is running.
 */
export function ChatsBody({
  projectId,
  scopeWorkId,
  noWorkId,
  currentThreadId,
  onOpenChat,
  onNewChat,
  onShowAllChats,
  onShowWork,
  footer,
}: {
  projectId: string;
  scopeWorkId: string | null;
  noWorkId: string | null;
  currentThreadId: string | null;
  onOpenChat: (threadId: string) => void;
  onNewChat: () => void;
  onShowAllChats: () => void;
  onShowWork: (workId: string) => void;
  footer?: ReactNode;
}) {
  const { threads } = useProjectThreads(projectId);
  const { works } = useWorks(projectId);
  const groups = useMemo(
    () => groupChats(threads ?? [], scopeWorkId ?? noWorkId, noWorkId, currentThreadId),
    [threads, scopeWorkId, noWorkId, currentThreadId],
  );
  const workName = (workId: string) =>
    workId === noWorkId
      ? t`Chats without a Work`
      : (works?.find((work) => work.id === workId)?.name ?? "");

  const row = (thread: ThreadListItem, state: RowState) => (
    <div key={thread.id}>
      <ChatRow
        thread={thread}
        state={state}
        current={thread.id === currentThreadId}
        onOpen={() => onOpenChat(thread.id)}
      />
      {groups.helpers.get(thread.id)?.map((helper) => (
        <ChatRow
          key={helper.id}
          thread={helper}
          state="running"
          nested
          current={helper.id === currentThreadId}
          onOpen={() => onOpenChat(helper.id)}
        />
      ))}
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SourcePane
        label={t`Chats`}
        actions={<PaneHeaderActionButton icon={Plus} label={t`New chat`} onClick={onNewChat} />}
      >
        {threads === null ? (
          <SourceHint status>
            <Trans>Loading…</Trans>
          </SourceHint>
        ) : (
          <>
            {/* One list, most urgent first; the mark on a row says its state. */}
            <div className="pt-1">
              {groups.needsYou.map((thread) => row(thread, "needs-you"))}
              {groups.running.map((thread) => row(thread, "running"))}
              {groups.idle.map((thread) => row(thread, "idle"))}
              {groups.older > 0 ? (
                <button
                  type="button"
                  onClick={onShowAllChats}
                  className={cn(ROW_BUTTON, contextTreeFileRowClassName(false), role.secondary)}
                  style={{ paddingLeft: rowPaddingLeft(1) }}
                >
                  <Trans>Older</Trans>
                </button>
              ) : null}
            </div>
            {groups.needsYou.length + groups.running.length + groups.idle.length === 0 ? (
              <SourceHint>
                <Trans>No chats in this Work yet.</Trans>
              </SourceHint>
            ) : null}
            <Group label={t`Other Works`} hidden={groups.otherWorks.length === 0}>
              {groups.otherWorks.map((other) => (
                <button
                  key={other.workId}
                  type="button"
                  onClick={() => onShowWork(other.workId)}
                  className={cn(ROW_BUTTON, contextTreeFileRowClassName(false))}
                  style={{ paddingLeft: rowPaddingLeft(0) }}
                >
                  <RowIcon icon={Layers} />
                  <span className="ml-0.5 min-w-0 flex-1 truncate">{workName(other.workId)}</span>
                  <span
                    className={cn(
                      "shrink-0 pr-1",
                      role.rowSecondary,
                      other.needsYou > 0 && "text-jade-text",
                    )}
                  >
                    {other.needsYou > 0 ? (
                      <Trans>{other.needsYou} waiting on you</Trans>
                    ) : (
                      <Trans>{other.running} working</Trans>
                    )}
                  </span>
                </button>
              ))}
            </Group>
          </>
        )}
      </SourcePane>
      {footer}
    </div>
  );
}

/** A row that is one button: the row frame, full width inside its inset. */
const ROW_BUTTON = "focus-ring w-[calc(100%-1rem)] text-left";

function Group({
  label,
  hidden,
  children,
}: {
  label: string;
  hidden: boolean;
  children: ReactNode;
}) {
  if (hidden) return null;
  return (
    <section aria-label={label} className="pt-2">
      <h3 className={cn("pr-2 pb-1 pl-3.5", role.groupLabel)}>{label}</h3>
      {children}
    </section>
  );
}

type RowState = "needs-you" | "running" | "idle";

function ChatRow({
  thread,
  state,
  current,
  nested = false,
  onOpen,
}: {
  thread: ThreadListItem;
  state: RowState;
  current: boolean;
  nested?: boolean;
  onOpen: () => void;
}) {
  const title = displayThreadTitle(thread.title);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={current ? "page" : undefined}
      className={cn(ROW_BUTTON, "gap-2", contextTreeFileRowClassName(current))}
      style={{ paddingLeft: rowPaddingLeft(nested ? 1 : 0) }}
    >
      {thread.agentName ? (
        <span
          aria-hidden
          className={cn(
            "grid size-4 shrink-0 place-items-center rounded-sm border border-border-subtle font-medium leading-none",
            role.rowSecondary,
          )}
          title={thread.agentName}
        >
          {thread.agentName.slice(0, 1).toUpperCase()}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {state === "idle" ? null : (
        <span className="flex w-5 shrink-0 items-center justify-center">
          <StateMark state={state} />
        </span>
      )}
    </button>
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

export function groupChats(
  threads: readonly ThreadListItem[],
  scopeWorkId: string | null,
  noWorkId: string | null,
  currentThreadId: string | null,
): ChatGroups {
  const inScope = (thread: ThreadListItem) =>
    (thread.workId ?? noWorkId) === scopeWorkId || thread.id === currentThreadId;
  const helpers = new Map<string, ThreadListItem[]>();
  for (const thread of threads) {
    if (thread.kind !== "subagent" || thread.spawnStatus !== "running" || !thread.parentThreadId)
      continue;
    const list = helpers.get(thread.parentThreadId) ?? [];
    list.push(thread);
    helpers.set(thread.parentThreadId, list);
  }
  const recent = threads
    .filter((thread) => thread.kind === "primary" && thread.status !== "archived")
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  const needsYou: ThreadListItem[] = [];
  const running: ThreadListItem[] = [];
  const idle: ThreadListItem[] = [];
  const others = new Map<string, { workId: string; running: number; needsYou: number }>();
  for (const thread of recent) {
    const busy = thread.runningTurnId !== null;
    if (!inScope(thread)) {
      if (!busy && !thread.actionRequired) continue;
      const workId = thread.workId ?? noWorkId;
      if (!workId) continue;
      const other = others.get(workId) ?? { workId, running: 0, needsYou: 0 };
      if (thread.actionRequired) other.needsYou += 1;
      else other.running += 1;
      others.set(workId, other);
      continue;
    }
    if (thread.actionRequired) needsYou.push(thread);
    else if (busy) running.push(thread);
    else idle.push(thread);
  }
  return {
    needsYou,
    running,
    idle: idle.slice(0, IDLE_SHOWN),
    older: Math.max(0, idle.length - IDLE_SHOWN),
    helpers,
    otherWorks: [...others.values()],
  };
}
