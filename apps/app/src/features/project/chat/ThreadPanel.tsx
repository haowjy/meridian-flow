/**
 * ThreadPanel — project-scoped conversation list shared by shell navigation.
 *
 * Desktop embeds it in persistent side rails; the phone shell embeds the same
 * list in its drawer so grouping, pinning, lifecycle badges, and create-chat
 * behavior stay one implementation.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ThreadGroupBy } from "@meridian/contracts/preferences";
import type { ThreadListItem } from "@meridian/contracts/protocol";
import { Check, ChevronRight, PanelLeftClose, Pause, Plus, Star } from "lucide-react";
import { useMemo, useState } from "react";

import {
  useProjectPreferences,
  useUpdateProjectPreferences,
} from "@/client/query/useProjectPreferences";
import { useLayoutActions, useLayoutStore, useThreadStore } from "@/client/stores";
import { DraftIndicatorChip } from "@/features/project/DraftIndicatorChip";
import { cn } from "@/lib/utils";

import {
  groupThreadsByDate,
  sortThreadsByRecency,
  useProjectThreadGroups,
  type WorkItem,
} from "../data/dashboard-data";
import {
  draftIndicatorDisplay,
  type LifecycleState,
  lifecycleDisplay,
  lifecycleFor,
} from "../lifecycle";
import { relativeTime } from "../relative-time";
import { useCreateChat } from "./use-create-chat";

export type ThreadFilter = "all" | "waiting" | "running" | "errored";

export type ThreadPanelProps = {
  projectId: string;
  activeThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  /** When set, renders a collapse button in the panel header. */
  onCollapse?: () => void;
  /**
   * When true, the panel drops its own `bg-surface-subtle` fill so it inherits
   * the parent surface (used when embedded in the persistent `LeftSidebar`,
   * which owns one continuous `bg-sidebar` tone).
   */
  transparent?: boolean;
  /**
   * When true, the panel renders only the scrollable list — no `Chats` header
   * / new-chat / collapse row. The embedding `LeftSidebar` owns that chrome.
   */
  hideHeader?: boolean;
  /** Server-backed grouping preference for primary threads. */
  groupBy?: ThreadGroupBy;
  /**
   * Session-local lifecycle filter. The grouped list honors the filter; pinned
   * threads are always shown (the Pinned section ignores filter/search).
   */
  filter?: ThreadFilter;
  /**
   * Session-local title search. The grouped list honors the search; pinned
   * threads are always shown (the Pinned section ignores filter/search).
   */
  searchQuery?: string;
  /**
   * Server-backed pinned primary thread ids, rendered in the Pinned section
   * above the grouped list (removed from their normal group).
   */
  pinnedThreadIds?: string[];
};

/**
 * Thread list panel. Renders pinned primaries first in a Pinned section, then
 * groups the REMAINING primary threads by work, date bucket, or flat recency.
 * Subagents stay nested under their parent row in every grouping mode.
 */
export function ThreadPanel({
  projectId,
  activeThreadId,
  onSelectThread,
  onCollapse,
  transparent = false,
  hideHeader = false,
  groupBy,
  filter = "all",
  searchQuery = "",
  pinnedThreadIds,
}: ThreadPanelProps) {
  const { workItems, primaryThreads, subagentsByParent, ungroupedThreads, threadById } =
    useProjectThreadGroups(projectId);
  const { createChat, creating } = useCreateChat(projectId, onSelectThread);
  const { preferences } = useProjectPreferences(projectId);
  const updatePreferences = useUpdateProjectPreferences(projectId);
  const now = useThreadStore((s) => s.now);

  const resolvedGroupBy = groupBy ?? preferences.threadGroupBy;
  const resolvedPinnedThreadIds = pinnedThreadIds ?? preferences.pinnedThreadIds;
  const pinnedIdSet = useMemo(() => new Set(resolvedPinnedThreadIds), [resolvedPinnedThreadIds]);
  const normalizedSearch = searchQuery.trim().toLocaleLowerCase();
  const pinnedThreads = useMemo(
    () =>
      resolvedPinnedThreadIds
        .map((id) => threadById.get(id))
        .filter((thread): thread is ThreadListItem => thread?.kind === "primary"),
    [resolvedPinnedThreadIds, threadById],
  );
  const visibleThreads = useMemo(
    () =>
      sortThreadsByRecency(primaryThreads).filter(
        (thread) =>
          !pinnedIdSet.has(thread.id) &&
          matchesThreadFilter(thread, filter) &&
          matchesThreadSearch(thread, normalizedSearch),
      ),
    [filter, normalizedSearch, pinnedIdSet, primaryThreads],
  );
  const visibleThreadById = useMemo(
    () => new Map(visibleThreads.map((thread) => [thread.id, thread] as const)),
    [visibleThreads],
  );
  const visibleWorkItems = useMemo(
    () =>
      workItems
        .map((group) => {
          const threads = sortThreadsByRecency(
            group.threadIds
              .map((id) => visibleThreadById.get(id))
              .filter((thread): thread is ThreadListItem => Boolean(thread)),
          );
          return { ...group, threadIds: threads.map((thread) => thread.id) };
        })
        .filter((group) => group.threadIds.length > 0),
    [visibleThreadById, workItems],
  );
  const visibleUngroupedThreads = useMemo(
    () =>
      sortThreadsByRecency(ungroupedThreads.filter((thread) => visibleThreadById.has(thread.id))),
    [ungroupedThreads, visibleThreadById],
  );
  const dateBuckets = useMemo(() => groupThreadsByDate(visibleThreads, now), [now, visibleThreads]);

  const togglePinned = (threadId: string) => {
    const nextPinnedThreadIds = pinnedIdSet.has(threadId)
      ? resolvedPinnedThreadIds.filter((id) => id !== threadId)
      : [...resolvedPinnedThreadIds, threadId];
    updatePreferences.mutate({ pinnedThreadIds: nextPinnedThreadIds });
  };
  const hasVisibleThreads = pinnedThreads.length > 0 || visibleThreads.length > 0;

  return (
    <div className={cn("flex h-full min-h-0 w-full flex-col", !transparent && "bg-surface-subtle")}>
      {hideHeader ? null : (
        <div className="flex items-center justify-between px-3 py-3">
          <span className="text-fine font-semibold uppercase tracking-wide text-muted-foreground">
            <Trans>Chats</Trans>
          </span>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              aria-label={t`New chat`}
              title={t`New chat`}
              disabled={creating}
              onClick={() => void createChat()}
              className="focus-ring grid size-6 cursor-pointer place-items-center rounded text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground disabled:opacity-50"
            >
              <Plus className="size-3.5" aria-hidden />
            </button>
            {onCollapse ? (
              <button
                type="button"
                aria-label={t`Collapse thread list`}
                title={t`Collapse thread list`}
                onClick={onCollapse}
                className="focus-ring grid size-6 cursor-pointer place-items-center rounded text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
              >
                <PanelLeftClose className="size-3.5" aria-hidden />
              </button>
            ) : null}
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overflow-x-hidden px-1.5 pb-3">
        {primaryThreads.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            <Trans>No conversations yet</Trans>
          </div>
        ) : null}

        {primaryThreads.length > 0 && !hasVisibleThreads ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            <Trans>No matching conversations</Trans>
          </div>
        ) : null}

        {pinnedThreads.length > 0 ? (
          <PinnedSection
            threads={pinnedThreads}
            activeThreadId={activeThreadId}
            onSelectThread={onSelectThread}
            subagentsByParent={subagentsByParent}
            pinnedIdSet={pinnedIdSet}
            onTogglePin={togglePinned}
            surface={transparent ? "sidebar" : "panel"}
          />
        ) : null}

        {visibleThreads.length > 0 ? (
          <>
            {resolvedGroupBy === "flat" ? (
              <ThreadRows
                threads={visibleThreads}
                activeThreadId={activeThreadId}
                onSelectThread={onSelectThread}
                subagentsByParent={subagentsByParent}
                pinnedIdSet={pinnedIdSet}
                onTogglePin={togglePinned}
              />
            ) : null}

            {resolvedGroupBy === "date"
              ? dateBuckets.map((bucket) => (
                  <ThreadSection
                    key={bucket.id}
                    title={dateBucketLabel(bucket.id)}
                    threads={bucket.threadIds
                      .map((id) => visibleThreadById.get(id))
                      .filter((thread): thread is ThreadListItem => Boolean(thread))}
                    activeThreadId={activeThreadId}
                    onSelectThread={onSelectThread}
                    subagentsByParent={subagentsByParent}
                    pinnedIdSet={pinnedIdSet}
                    onTogglePin={togglePinned}
                  />
                ))
              : null}

            {resolvedGroupBy === "work"
              ? visibleWorkItems.map((group) => (
                  <WorkGroup
                    key={group.id}
                    group={group}
                    getThread={(id) => visibleThreadById.get(id)}
                    subagentsByParent={subagentsByParent}
                    activeThreadId={activeThreadId}
                    onSelect={onSelectThread}
                    pinnedIdSet={pinnedIdSet}
                    onTogglePin={togglePinned}
                  />
                ))
              : null}

            {resolvedGroupBy === "work" && visibleUngroupedThreads.length > 0 ? (
              <>
                <div className="mx-3 my-1 h-px bg-border-subtle" aria-hidden />
                <ThreadSection
                  title={t`No work`}
                  threads={visibleUngroupedThreads}
                  activeThreadId={activeThreadId}
                  onSelectThread={onSelectThread}
                  subagentsByParent={subagentsByParent}
                  pinnedIdSet={pinnedIdSet}
                  onTogglePin={togglePinned}
                />
              </>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

type ThreadRowsProps = {
  threads: ThreadListItem[];
  activeThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  subagentsByParent: Map<string, ThreadListItem[]>;
  pinnedIdSet: Set<string>;
  onTogglePin: (threadId: string) => void;
};

function ThreadRows({
  threads,
  activeThreadId,
  onSelectThread,
  subagentsByParent,
  pinnedIdSet,
  onTogglePin,
}: ThreadRowsProps) {
  return (
    <ul className="flex flex-col gap-0.5">
      {threads.map((thread) => (
        <ThreadRow
          key={thread.id}
          thread={thread}
          active={thread.id === activeThreadId}
          onSelect={onSelectThread}
          subagents={subagentsByParent.get(thread.id) ?? []}
          activeThreadId={activeThreadId}
          pinned={pinnedIdSet.has(thread.id)}
          onTogglePin={onTogglePin}
        />
      ))}
    </ul>
  );
}

type ThreadSectionProps = ThreadRowsProps & {
  title: string;
};

function ThreadSection({ title, threads, ...rowsProps }: ThreadSectionProps) {
  return (
    <section>
      <div className="px-3 pb-1 pt-2 text-meta font-semibold uppercase tracking-label text-ink-subtle">
        {title}
      </div>
      <ThreadRows threads={threads} {...rowsProps} />
    </section>
  );
}

function PinnedSection({
  surface,
  ...sectionProps
}: ThreadRowsProps & { surface: "sidebar" | "panel" }) {
  return (
    <section
      className={cn(
        "sticky top-0 z-10 -mx-1.5 border-b border-border-subtle px-1.5 pb-2",
        surface === "sidebar" && "bg-sidebar",
        surface === "panel" && "bg-surface-subtle",
      )}
    >
      <div className="px-3 pb-1 pt-2 text-meta font-semibold uppercase tracking-label text-muted-foreground">
        <Trans>Pinned</Trans>
      </div>
      <ThreadRows {...sectionProps} />
    </section>
  );
}

function matchesThreadFilter(thread: ThreadListItem, filter: ThreadFilter): boolean {
  const lifecycle = lifecycleFor(thread);
  switch (filter) {
    case "all":
      return true;
    case "waiting":
      return lifecycle === "waiting";
    case "running":
      return lifecycle === "executing";
    case "errored":
      return lifecycle === "errored";
  }
}

function matchesThreadSearch(thread: ThreadListItem, normalizedSearch: string): boolean {
  if (!normalizedSearch) return true;
  return (thread.title?.trim() || t`New chat`).toLocaleLowerCase().includes(normalizedSearch);
}

function dateBucketLabel(bucket: "today" | "yesterday" | "previous7" | "earlier"): string {
  switch (bucket) {
    case "today":
      return t`Today`;
    case "yesterday":
      return t`Yesterday`;
    case "previous7":
      return t`Previous 7 days`;
    case "earlier":
      return t`Earlier`;
  }
}

/* ── Work group ───────────────────────────────────────────────────── */

type WorkGroupProps = {
  group: WorkItem;
  getThread: (id: string) => ThreadListItem | undefined;
  subagentsByParent: Map<string, ThreadListItem[]>;
  activeThreadId: string | null;
  onSelect: (threadId: string) => void;
  pinnedIdSet: Set<string>;
  onTogglePin: (threadId: string) => void;
};

function WorkGroup({
  group,
  getThread,
  subagentsByParent,
  activeThreadId,
  onSelect,
  pinnedIdSet,
  onTogglePin,
}: WorkGroupProps) {
  const collapsed = useLayoutStore((s) => s.collapsedWorkIds.includes(group.id));
  const { toggleWorkGroupCollapsed } = useLayoutActions();
  const isCollapsed = collapsed;

  const rows = (
    <ul className="flex flex-col gap-0.5">
      {group.threadIds.map((id) => {
        const thread = getThread(id);
        if (!thread) return null;
        const subs = subagentsByParent.get(thread.id) ?? [];
        return (
          <ThreadRow
            key={thread.id}
            thread={thread}
            active={thread.id === activeThreadId}
            onSelect={onSelect}
            subagents={subs}
            activeThreadId={activeThreadId}
            pinned={pinnedIdSet.has(thread.id)}
            onTogglePin={onTogglePin}
          />
        );
      })}
    </ul>
  );

  return (
    <div>
      <button
        type="button"
        aria-expanded={!isCollapsed}
        onClick={() => toggleWorkGroupCollapsed(group.id)}
        className="focus-ring group/work flex w-full cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent"
      >
        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-ink-subtle transition-transform",
            !isCollapsed && "rotate-90",
          )}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate text-meta font-semibold uppercase tracking-label text-ink-subtle">
          {group.name}
        </span>
        <span className="shrink-0 rounded-full bg-chip-muted-bg px-1.5 text-micro font-medium tabular-nums text-ink-subtle">
          {group.threadIds.length}
        </span>
      </button>
      {isCollapsed ? null : rows}
    </div>
  );
}

/* ── Thread row + subagents ───────────────────────────────────────── */

type ThreadRowProps = {
  thread: ThreadListItem;
  active: boolean;
  onSelect: (threadId: string) => void;
  subagents?: ThreadListItem[];
  activeThreadId?: string | null;
  pinned: boolean;
  onTogglePin: (threadId: string) => void;
};

function ThreadRow({
  thread,
  active,
  onSelect,
  subagents = [],
  activeThreadId,
  pinned,
  onTogglePin,
}: ThreadRowProps) {
  const lifecycle = lifecycleFor(thread);
  const hasSubagents = subagents.length > 0;
  const childActive = activeThreadId ? subagents.some((s) => s.id === activeThreadId) : false;
  const [expanded, setExpanded] = useState(hasSubagents && (active || childActive));
  const streamingThreadId = useThreadStore((s) => s.streamingThreadId);
  const now = useThreadStore((s) => s.now);

  const title = thread.title?.trim() || t`New chat`;
  const live = thread.id === streamingThreadId;
  const dot = live ? (
    <span aria-hidden className="streaming-dot" />
  ) : (
    <StatusDot lifecycle={lifecycle} />
  );
  const rel = relativeTime(thread.updatedAt, now);
  const lifecycleLabel = lifecycleDisplay(lifecycle).label;
  const draftDisplay = draftIndicatorDisplay(thread.pendingDraftCount);
  const rowLabel = draftDisplay
    ? `${title} — ${lifecycleLabel} — ${draftDisplay.label}`
    : `${title} — ${lifecycleLabel}`;
  const pinLabel = pinned ? t`Unpin chat` : t`Pin chat`;

  return (
    <li>
      <div className="group flex items-center gap-0.5 px-1">
        {hasSubagents ? (
          <button
            type="button"
            aria-label={t`Toggle subagents`}
            aria-expanded={expanded}
            onClick={() => setExpanded((prev) => !prev)}
            className="focus-ring grid size-6 shrink-0 cursor-pointer place-items-center rounded text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronRight
              className={cn("size-3 transition-transform", expanded && "rotate-90")}
              aria-hidden
            />
          </button>
        ) : (
          <div className="w-6 shrink-0" aria-hidden />
        )}

        <button
          type="button"
          onClick={() => onSelect(thread.id)}
          aria-label={rowLabel}
          className={cn(
            "focus-ring mb-px flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1 text-left transition-colors",
            active
              ? "bg-primary/10 font-medium text-foreground"
              : "text-ink-muted hover:bg-sidebar-accent hover:text-foreground",
          )}
        >
          <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
          {rel ? (
            <span className="shrink-0 text-fine font-normal tabular-nums text-ink-subtle">
              {rel}
            </span>
          ) : null}
          <DraftIndicatorChip count={thread.pendingDraftCount} />
          {dot}
        </button>
        <button
          type="button"
          aria-label={pinLabel}
          title={pinLabel}
          onClick={(event) => {
            event.stopPropagation();
            onTogglePin(thread.id);
          }}
          className={cn(
            "thread-row-pin focus-ring grid size-6 shrink-0 cursor-pointer place-items-center rounded text-muted-foreground opacity-0 transition-all group-hover:opacity-100 focus-visible:opacity-100 hover:bg-sidebar-accent hover:text-cinnabar",
            pinned && "text-cinnabar opacity-100",
          )}
        >
          <Star className={cn("size-3.5", pinned && "fill-current")} aria-hidden />
        </button>
      </div>

      {hasSubagents && expanded ? (
        <ul className="relative ml-4 mt-0.5 flex flex-col gap-0.5 border-l border-border-subtle pl-2">
          {subagents.map((sub) => (
            <SubagentRow
              key={sub.id}
              thread={sub}
              active={sub.id === activeThreadId}
              onSelect={onSelect}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function SubagentRow({
  thread,
  active,
  onSelect,
}: {
  thread: ThreadListItem;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  const lifecycle = lifecycleFor(thread);
  const title = thread.title?.trim() || t`Subtask`;
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(thread.id)}
        className={cn(
          "focus-ring flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors",
          active
            ? "bg-primary/10 font-medium text-foreground"
            : "text-ink-subtle hover:bg-sidebar-accent hover:text-foreground",
          lifecycle === "interrupt" ? "bg-destructive-tint/60" : undefined,
        )}
      >
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <DraftIndicatorChip count={thread.pendingDraftCount} />
        <StatusDot lifecycle={lifecycle} small />
      </button>
    </li>
  );
}

function StatusDot({ lifecycle, small = false }: { lifecycle: LifecycleState; small?: boolean }) {
  const size = small ? "size-3" : "size-3.5";
  switch (lifecycle) {
    case "executing":
    case "grilling":
      return (
        <span
          aria-hidden
          className={cn("shrink-0 rounded-full bg-status-streaming", small ? "size-1.5" : "size-2")}
        />
      );
    case "waiting":
      return (
        <span
          aria-hidden
          className={cn("shrink-0 rounded-full bg-status-live-dot", small ? "size-1.5" : "size-2")}
        />
      );
    case "completed":
      return (
        <Check
          aria-hidden
          className={cn("shrink-0 text-status-done-foreground", size)}
          strokeWidth={2.5}
        />
      );
    case "interrupt":
      return (
        <Pause aria-hidden className={cn("shrink-0 text-destructive", size)} strokeWidth={2.5} />
      );
    case "errored":
      return (
        <span
          aria-hidden
          className={cn("shrink-0 rounded-full bg-destructive", small ? "size-1.5" : "size-2")}
        />
      );
    case "idle":
      return (
        <span
          aria-hidden
          className={cn(
            "shrink-0 rounded-full border border-border",
            small ? "size-1.5" : "size-2",
          )}
        />
      );
  }
  const _exhaust: never = lifecycle;
  return _exhaust;
}
