/**
 * ThreadListControls — sidebar controls for thread grouping, filtering, and
 * search.
 *
 * Purpose: keep the persistent group-by preference distinct from session-local
 * filter/search inputs. ViewMenu writes server-backed group-by preferences and
 * session-local filter state from one compact trigger; ThreadSearch stays
 * controlled by the embedding sidebar.
 *
 * Key decisions:
 *  - ViewMenu merges group-by and filter into `[search flex-1] [view]` so the
 *    controls row stays uncluttered next to the CHATS label's new-chat action.
 *  - Icon-only square trigger with native `title` for hover discoverability;
 *    `aria-label` states the current group-by and filter for screen readers.
 *  - Filter shows a subtle `bg-primary` dot when a non-default filter is active
 *    so the user knows a filter is applied without opening the menu.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ThreadGroupBy } from "@meridian/contracts/preferences";
import { Search, SlidersHorizontal } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import type { ThreadFilter } from "../chat/ThreadPanel";

type ViewMenuProps = {
  groupBy: ThreadGroupBy;
  groupByDisabled?: boolean;
  onGroupByChange: (value: ThreadGroupBy) => void;
  filter: ThreadFilter;
  onFilterChange: (value: ThreadFilter) => void;
};

type ThreadSearchProps = {
  value: string;
  onChange: (value: string) => void;
};

const GROUP_LABELS: Record<ThreadGroupBy, string> = {
  work: t`Work`,
  date: t`Date`,
  flat: t`Flat`,
};

const FILTER_LABELS: Record<ThreadFilter, string> = {
  all: t`All`,
  waiting: t`Waiting`,
  running: t`Running`,
  errored: t`Errored`,
};

const ICON_TRIGGER_CLASSES =
  "focus-ring relative inline-flex size-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-border-subtle bg-card p-0 text-sm font-medium text-ink-muted shadow-xs transition-all hover:border-border-focus hover:bg-sidebar-accent hover:text-foreground active:scale-[0.98] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0";

export function ViewMenu({
  groupBy,
  groupByDisabled = false,
  onGroupByChange,
  filter,
  onFilterChange,
}: ViewMenuProps) {
  const isFilterActive = filter !== "all";
  const label = t`View: group by ${GROUP_LABELS[groupBy]}, filter ${FILTER_LABELS[filter]}`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        type="button"
        disabled={groupByDisabled}
        aria-label={label}
        title={label}
        className={cn(
          ICON_TRIGGER_CLASSES,
          isFilterActive && "border-primary/40 text-primary hover:text-primary",
        )}
      >
        <SlidersHorizontal className="size-4" aria-hidden />
        {isFilterActive ? (
          <span aria-hidden className="absolute right-1 top-1 size-1.5 rounded-full bg-primary" />
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuLabel>
          <Trans>Group by</Trans>
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={groupBy}
          onValueChange={(next) => onGroupByChange(next as ThreadGroupBy)}
        >
          <DropdownMenuRadioItem value="work">
            <Trans>Work</Trans>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="date">
            <Trans>Date</Trans>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="flat">
            <Trans>Flat</Trans>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>
          <Trans>Filter</Trans>
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={filter}
          onValueChange={(next) => onFilterChange(next as ThreadFilter)}
        >
          <DropdownMenuRadioItem value="all">
            <Trans>All</Trans>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="waiting">
            <Trans>Waiting</Trans>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="running">
            <Trans>Running</Trans>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="errored">
            <Trans>Errored</Trans>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ThreadSearch({ value, onChange }: ThreadSearchProps) {
  return (
    <div className="relative min-w-0 flex-1">
      <Search
        aria-hidden
        className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        type="search"
        value={value}
        aria-label={t`Search chats`}
        placeholder={t`Search chats`}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 w-full border-border-subtle bg-card pl-7 md:!text-[13px]"
      />
    </div>
  );
}
