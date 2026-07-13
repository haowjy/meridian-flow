/**
 * HomeScreen — the Home destination: a Chats overview across every Work in the
 * project. Ports the P5 proto's overview table, wired to real data.
 *
 * The screen is a thin view over the `chats-overview` data model: it renders a
 * stat strip, filter chips, and a sortable table whose columns, filters, and
 * sorts are all declarative config over the flat `ChatRow` model — so the table
 * stays easy to sort and rework (add a column / filter / sort key = one-line
 * edit, never a JSX rewrite). Clicking a row deep-links into the Chat
 * destination via `onSelectThread`.
 *
 * Vocab: rows are **Chats** (primary threads), grouped by **Work**. The pane's
 * top bar is owned by `PaneHeader` in `ProjectView`; this renders body only.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ArrowUpDown, Plus } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SectionLabel } from "@/components/ui/section-label";
import { cn } from "@/lib/utils";

import { useCreateChat } from "../chat/use-create-chat";
import { lifecycleDisplay } from "../lifecycle";
import { relativeTime } from "../relative-time";
import {
  CHAT_FILTERS,
  type ChatFilterKey,
  type ChatRow,
  type ChatSortKey,
  type SortDirection,
  selectChatRows,
  useChatsOverview,
} from "./chats-overview";

export type HomeScreenProps = {
  projectId: string;
  onSelectThread: (threadId: string) => void;
};

export type HomeChatListRenderState = {
  loaded: boolean;
  rows: ChatRow[];
  visible: ChatRow[];
  onSelectThread: (threadId: string) => void;
  sortKey: ChatSortKey;
  direction: SortDirection;
  onSort: (key: ChatSortKey) => void;
};

/* ── Column model ──────────────────────────────────────────────────────
 * Declarative table columns. `sortKey` (when set) makes the header a sort
 * toggle. Reorder / add / remove a column by editing this array — the header
 * row, the cells, and the sort affordance all derive from it. */
type ChatColumn = {
  key: string;
  header: ReactNode;
  /** Grid track for this column. */
  track: string;
  /** When set, the header toggles this sort key. */
  sortKey?: ChatSortKey;
  align?: "start" | "end";
  cell: (row: ChatRow) => ReactNode;
};

const COLUMNS: ChatColumn[] = [
  {
    key: "chat",
    header: <Trans>Chat</Trans>,
    track: "minmax(0,1fr)",
    sortKey: "title",
    cell: (row) => (
      <span className="flex min-w-0 items-center gap-2.5">
        <StatusDot row={row} />
        <span className="truncate text-foreground">{row.title || t`New chat`}</span>
      </span>
    ),
  },
  {
    key: "work",
    header: <Trans>Work</Trans>,
    track: "minmax(0,12rem)",
    sortKey: "work",
    cell: (row) => (
      <span className="block truncate text-meta text-muted-foreground" title={row.workLabel ?? "—"}>
        {row.workLabel ?? "—"}
      </span>
    ),
  },
  {
    key: "status",
    header: <Trans>Status</Trans>,
    track: "auto",
    sortKey: "status",
    cell: (row) => <StatusBadge row={row} />,
  },
  {
    key: "updated",
    header: <Trans>Updated</Trans>,
    track: "auto",
    sortKey: "updated",
    align: "end",
    cell: (row) => (
      <span className="whitespace-nowrap text-meta tabular-nums text-muted-foreground">
        {relativeTime(row.updatedAt, Date.now())}
      </span>
    ),
  },
];

const GRID_TEMPLATE = COLUMNS.map((c) => c.track).join(" ");

export function HomeScreen(props: HomeScreenProps) {
  return (
    <HomeOverviewBody
      {...props}
      containerClassName="md:px-8 md:py-8"
      headerClassName="md:flex-row md:items-end md:justify-between"
      createButtonClassName="md:h-9"
    >
      {(state) => <DesktopChatTable {...state} />}
    </HomeOverviewBody>
  );
}

export function HomeOverviewBody({
  projectId,
  onSelectThread,
  children,
  containerClassName,
  headerClassName,
  createButtonClassName,
}: HomeScreenProps & {
  children: (state: HomeChatListRenderState) => ReactNode;
  containerClassName?: string;
  headerClassName?: string;
  createButtonClassName?: string;
}) {
  const { rows, workCount, loaded } = useChatsOverview(projectId);
  const { createChat, creating } = useCreateChat(projectId, onSelectThread);

  const [filter, setFilter] = useState<ChatFilterKey>("all");
  const [sortKey, setSortKey] = useState<ChatSortKey>("updated");
  const [direction, setDirection] = useState<SortDirection>("desc");

  const visible = useMemo(
    () => selectChatRows(rows, filter, sortKey, direction),
    [rows, filter, sortKey, direction],
  );

  function toggleSort(next: ChatSortKey) {
    if (next === sortKey) {
      setDirection((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(next);
      // Recency reads newest-first; text/status read A→Z by default.
      setDirection(next === "updated" ? "desc" : "asc");
    }
  }

  const stats = useMemo(() => deriveStats(rows, workCount), [rows, workCount]);

  return (
    <div className="app-scroll">
      <div
        className={cn(
          "mx-auto flex w-full max-w-[1080px] flex-col gap-6 px-4 py-5",
          containerClassName,
        )}
      >
        <header className={cn("flex flex-col gap-4", headerClassName)}>
          <div className="flex min-w-0 flex-col gap-2">
            <SectionLabel>
              <Trans>Home</Trans>
            </SectionLabel>
            <h1 className="text-[clamp(22px,3vw,30px)] font-semibold leading-tight tracking-prose-heading text-foreground">
              <Trans>Every chat across your work</Trans>
            </h1>
            <p className="max-w-[58ch] text-compact text-ink-muted">
              <Trans>
                One surface for every chat in this project. Jump into any chat, or start a new one.
              </Trans>
            </p>
          </div>
          <Button
            type="button"
            size="lg"
            disabled={creating}
            onClick={() => void createChat()}
            className={createButtonClassName}
          >
            <Plus className="size-4" aria-hidden />
            <Trans>New chat</Trans>
          </Button>
        </header>

        <StatStrip stats={stats} />

        <div className="flex flex-wrap items-center gap-1.5">
          {CHAT_FILTERS.map((f) => (
            <FilterChip
              key={f.key}
              label={f.label}
              active={f.key === filter}
              onClick={() => setFilter(f.key)}
            />
          ))}
        </div>

        {children({
          loaded,
          rows,
          visible,
          onSelectThread,
          sortKey,
          direction,
          onSort: toggleSort,
        })}
      </div>
    </div>
  );
}

function DesktopChatTable({
  loaded,
  rows,
  visible,
  onSelectThread,
  sortKey,
  direction,
  onSort,
}: HomeChatListRenderState) {
  return (
    <div
      className="grid overflow-hidden rounded-xl border border-border-subtle bg-card"
      style={{ gridTemplateColumns: GRID_TEMPLATE }}
      data-desktop-home-table
    >
      <div className="col-span-full grid grid-cols-subgrid items-center gap-x-4 border-b border-border-subtle px-4 py-2">
        {COLUMNS.map((col) => (
          <ColumnHeader
            key={col.key}
            column={col}
            active={col.sortKey === sortKey}
            direction={direction}
            onSort={onSort}
          />
        ))}
      </div>

      {!loaded ? (
        <EmptyRow>
          <Trans>Loading chats…</Trans>
        </EmptyRow>
      ) : visible.length === 0 ? (
        <EmptyRow>
          {rows.length === 0 ? (
            <Trans>No chats yet — start one to get going.</Trans>
          ) : (
            <Trans>Nothing matches this filter.</Trans>
          )}
        </EmptyRow>
      ) : (
        visible.map((row) => (
          <button
            key={row.id}
            type="button"
            onClick={() => onSelectThread(row.id)}
            className="focus-ring col-span-full grid grid-cols-subgrid items-center gap-x-4 border-b border-border-subtle px-4 py-2.5 text-left text-sm transition-colors last:border-b-0 hover:bg-sidebar-accent/30"
          >
            {COLUMNS.map((col) => (
              <span
                key={col.key}
                className={cn("min-w-0", col.align === "end" && "justify-self-end")}
              >
                {col.cell(row)}
              </span>
            ))}
          </button>
        ))
      )}
    </div>
  );
}

/* ── Sortable column header ────────────────────────────────────────── */

function ColumnHeader({
  column,
  active,
  direction,
  onSort,
}: {
  column: ChatColumn;
  active: boolean;
  direction: SortDirection;
  onSort: (key: ChatSortKey) => void;
}) {
  const label = <SectionLabel>{column.header}</SectionLabel>;
  if (!column.sortKey) {
    return (
      <span className={cn("text-muted-foreground", column.align === "end" && "justify-self-end")}>
        {label}
      </span>
    );
  }
  const sortKey = column.sortKey;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      aria-label={
        active ? t`Sorted ${direction === "asc" ? "ascending" : "descending"}` : undefined
      }
      className={cn(
        "focus-ring inline-flex items-center gap-1 rounded text-muted-foreground transition-colors hover:text-foreground",
        active && "text-foreground",
        column.align === "end" && "justify-self-end",
      )}
    >
      {label}
      <ArrowUpDown
        className={cn("size-3 transition-opacity", active ? "opacity-100" : "opacity-40")}
        aria-hidden
      />
    </button>
  );
}

/* ── Stat strip ────────────────────────────────────────────────────── */

type StatTone = "primary" | "attention" | "danger" | "muted";
type Stat = { key: string; label: ReactNode; value: number; tone: StatTone };

function deriveStats(rows: ChatRow[], workCount: number): Stat[] {
  const running = rows.filter((r) => r.lifecycle === "executing").length;
  const waiting = rows.filter((r) => r.attention !== "none").length;
  const errored = rows.filter((r) => r.lifecycle === "errored").length;
  // Running + Waiting + Errored + Idle partition every chat — Idle must shed the
  // errored ones it used to absorb.
  const idle = rows.filter(
    (r) => r.lifecycle !== "executing" && r.lifecycle !== "errored" && r.attention === "none",
  ).length;
  return [
    { key: "running", label: <Trans>Running</Trans>, value: running, tone: "primary" },
    { key: "waiting", label: <Trans>Waiting on you</Trans>, value: waiting, tone: "attention" },
    { key: "errored", label: <Trans>Errored</Trans>, value: errored, tone: "danger" },
    { key: "idle", label: <Trans>Idle</Trans>, value: idle, tone: "muted" },
    { key: "work", label: <Trans>Work</Trans>, value: workCount, tone: "muted" },
  ];
}

function StatStrip({ stats }: { stats: Stat[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
      {stats.map((stat) => {
        // Danger cards only "light up" when there's something wrong; a zero
        // Errored count stays a calm neutral card, not an alarming red zero.
        const alarmed = stat.tone === "danger" && stat.value > 0;
        return (
          <div
            key={stat.key}
            className={cn(
              "flex flex-col gap-1 rounded-xl border px-4 py-3",
              alarmed
                ? "border-destructive-border bg-destructive-tint"
                : "border-border-subtle bg-card",
            )}
          >
            <SectionLabel>{stat.label}</SectionLabel>
            <span
              className={cn(
                "text-[clamp(20px,3vw,26px)] font-semibold leading-none tabular-nums",
                stat.tone === "primary" && "text-primary",
                stat.tone === "attention" && "text-status-live-foreground",
                stat.tone === "danger" && (alarmed ? "text-destructive" : "text-foreground"),
                stat.tone === "muted" && "text-foreground",
              )}
            >
              {stat.value}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ── Filter chip ───────────────────────────────────────────────────── */

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "focus-ring h-7 rounded-md border px-2.5 text-xs transition-colors",
        active
          ? "border-primary/40 bg-chip-primary-bg text-foreground"
          : "border-border-subtle bg-card text-muted-foreground hover:border-border hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

/* ── Row status atoms (token-driven via lifecycleDisplay) ──────────── */

export function StatusDot({ row }: { row: ChatRow }) {
  const display = lifecycleDisplay(row.lifecycle);
  return (
    <span aria-hidden className={cn("size-2 shrink-0 rounded-full bg-current", display.dotClass)} />
  );
}

function StatusBadge({ row }: { row: ChatRow }) {
  const display = lifecycleDisplay(row.lifecycle);
  return (
    <Badge variant="status" className={display.badgeClass}>
      {display.label}
    </Badge>
  );
}

function EmptyRow({ children }: { children: ReactNode }) {
  return (
    <div className="col-span-full px-4 py-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
