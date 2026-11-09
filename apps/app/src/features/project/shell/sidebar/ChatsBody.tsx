import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ThreadListItem } from "@meridian/contracts/protocol";
import { Layers, Plus } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { useWorks } from "@/client/query/useWorks";
import { IconButton } from "@/components/ui/icon-button";
import { displayThreadTitle } from "@/lib/thread-title";
import { cn } from "@/lib/utils";

/** Settled chats shown before "Older" hands over to the full list. */
const SETTLED_SHOWN = 6;

type ChatGroups = {
  needsYou: ThreadListItem[];
  running: ThreadListItem[];
  settled: ThreadListItem[];
  older: number;
  helpers: Map<string, ThreadListItem[]>;
  otherWorks: { workId: string; running: number; needsYou: number }[];
};

/**
 * Chat mode's sidebar: the scoped Work's chats by what they need from the
 * writer. Running helpers sit under their parent. Other Works keep one row each
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
      <div className="flex h-8 shrink-0 items-center justify-between pr-2 pl-4">
        <span className="text-[12px] font-medium text-ink-muted">
          <Trans>Chats</Trans>
        </span>
        <IconButton size="sm" aria-label={t`New chat`} title={t`New chat`} onClick={onNewChat}>
          <Plus className="size-4" aria-hidden />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {threads === null ? null : (
          <>
            <Group label={t`Needs you`} hidden={groups.needsYou.length === 0}>
              {groups.needsYou.map((thread) => row(thread, "needs-you"))}
            </Group>
            <Group label={t`Running`} hidden={groups.running.length === 0}>
              {groups.running.map((thread) => row(thread, "running"))}
            </Group>
            <Group label={t`Settled`} hidden={groups.settled.length === 0}>
              {groups.settled.map((thread) => row(thread, "settled"))}
              {groups.older > 0 ? (
                <button
                  type="button"
                  onClick={onShowAllChats}
                  className="focus-ring flex h-7 w-full items-center rounded-md pl-7 text-left text-[13px] text-ink-muted hover:bg-sidebar-accent/50 hover:text-foreground"
                >
                  <Trans>Older</Trans>
                </button>
              ) : null}
            </Group>
            {groups.needsYou.length + groups.running.length + groups.settled.length === 0 ? (
              <p className="px-2 py-2 text-[13px] text-ink-muted">
                <Trans>No chats in this Work yet.</Trans>
              </p>
            ) : null}
            <Group label={t`Other Works`} hidden={groups.otherWorks.length === 0}>
              {groups.otherWorks.map((other) => (
                <button
                  key={other.workId}
                  type="button"
                  onClick={() => onShowWork(other.workId)}
                  className="focus-ring flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-sidebar-accent/50"
                >
                  <Layers className="size-3.5 shrink-0 text-ink-muted" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{workName(other.workId)}</span>
                  <span className="shrink-0 text-[11px] text-primary">
                    {other.needsYou > 0 ? (
                      <Trans>{other.needsYou} needs you</Trans>
                    ) : (
                      <Trans>{other.running} running</Trans>
                    )}
                  </span>
                </button>
              ))}
            </Group>
          </>
        )}
      </div>
      {footer}
    </div>
  );
}

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
      <h3 className="px-2 pb-1 text-[11px] font-medium text-ink-subtle">{label}</h3>
      {children}
    </section>
  );
}

type RowState = "needs-you" | "running" | "settled";

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
      className={cn(
        "focus-ring flex h-7 w-full items-center gap-2 rounded-md pr-2 text-left text-[13px]",
        nested ? "pl-6" : "pl-2",
        current
          ? "bg-sidebar-accent font-medium text-foreground"
          : "text-foreground/90 hover:bg-sidebar-accent/50",
      )}
    >
      <StateMark state={state} />
      {thread.agentName ? (
        <span
          aria-hidden
          className="grid size-4 shrink-0 place-items-center rounded bg-foreground/8 text-[10px] font-medium text-ink-muted"
          title={thread.agentName}
        >
          {thread.agentName.slice(0, 1).toUpperCase()}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{title}</span>
    </button>
  );
}

function StateMark({ state }: { state: RowState }) {
  if (state === "running")
    return (
      <span
        role="img"
        aria-label={t`Running`}
        className="size-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-primary/25 border-t-primary motion-reduce:animate-none"
      />
    );
  if (state === "needs-you")
    return (
      <span
        role="img"
        aria-label={t`Needs you`}
        className="size-2 shrink-0 rounded-full bg-primary"
      />
    );
  return <span aria-hidden className="size-2 shrink-0 rounded-full border border-ink-subtle/60" />;
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
  const settled: ThreadListItem[] = [];
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
    else settled.push(thread);
  }
  return {
    needsYou,
    running,
    settled: settled.slice(0, SETTLED_SHOWN),
    older: Math.max(0, settled.length - SETTLED_SHOWN),
    helpers,
    otherWorks: [...others.values()],
  };
}
