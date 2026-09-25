/**
 * ThreadSwitcherPopover — project thread navigation from the chat pane header.
 *
 * Keeps switching primary, with recency visible at a glance; rename stays
 * attached only to the active row and creation sits above the list.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ThreadListItem } from "@meridian/contracts/protocol";
import { ChevronDown, Pencil, Plus, Search } from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";

import { useThreadStore } from "@/client/stores";
import { WorkIdentity } from "@/components/app/WorkIdentity";
import { useDensityPopoverCollisionProps } from "@/components/ui/density-popover-collision";
import {
  dropdownResultsClass,
  dropdownRowContainerClass,
  dropdownRowVariants,
  dropdownSearchClass,
  dropdownSurfaceVariants,
} from "@/components/ui/dropdown-presentation";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { sectionLabelVariants } from "@/components/ui/section-label";
import { useProjectThreadGroups } from "@/features/project/data/project-thread-groups";
import { PaneTitle } from "@/features/project/PaneTitle";
import { relativeTime } from "@/features/project/relative-time";
import { displayThreadTitle } from "@/lib/thread-title";
import { cn } from "@/lib/utils";

import { filterThreadsByTitle, shouldShowThreadSearch } from "./thread-switcher";

/* ── Switcher popover ──────────────────────────────────────────────── */

export function ThreadSwitcherPopover({
  projectId,
  activeThreadId,
  title,
  onSelectThread,
  onNewChat,
  onRename,
  variant = "quiet",
}: {
  projectId: string;
  activeThreadId: string | null;
  title: string;
  onSelectThread: (threadId: string) => void;
  onNewChat?: () => void;
  onRename?: () => void;
  /**
   * `quiet` — hover-pill trigger for chrome that stays chrome (the dock).
   * `tab` — the active-tab chip grammar: the chat pane's page material
   * continues up into the band, same as the document tab strip. Use only
   * where the pane below the band is `page-sheet`.
   */
  variant?: "quiet" | "tab";
}) {
  const densityPopoverCollisionProps = useDensityPopoverCollisionProps();
  const contentRef = useRef<HTMLDivElement>(null);
  const focusHandoff = useRef(false);
  const { workItems, primaryThreads, threadById, ungroupedThreads } =
    useProjectThreadGroups(projectId);
  const now = useThreadStore((state) => state.now);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const filteredThreads = filterThreadsByTitle(primaryThreads, query);
  const filteredIds = new Set(filteredThreads.map((thread) => thread.id));
  const visibleWorkItems = workItems
    .map((work) => ({
      ...work,
      threadIds: work.threadIds.filter((id) => filteredIds.has(id)),
    }))
    .filter((work) => work.threadIds.length > 0);
  const visibleUngrouped = ungroupedThreads.filter((thread) => filteredIds.has(thread.id));
  const showGroupHeaders = workItems.length > 1;
  const showSearch = shouldShowThreadSearch(primaryThreads.length);

  const changeOpen = (nextOpen: boolean) => {
    if (nextOpen) focusHandoff.current = false;
    setOpen(nextOpen);
    if (!nextOpen) setQuery("");
  };

  const selectThread = (threadId: string) => {
    focusHandoff.current = threadId !== activeThreadId;
    changeOpen(false);
    onSelectThread(threadId);
  };

  const startRename = () => {
    focusHandoff.current = true;
    changeOpen(false);
    onRename?.();
  };

  const handleNavigationKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    if (event.target instanceof HTMLInputElement && ["Home", "End"].includes(event.key)) return;
    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>("[data-switcher-focus]"),
    ).filter((element) => !element.hasAttribute("disabled"));
    if (focusable.length === 0) return;

    const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? focusable.length - 1
          : event.key === "ArrowDown"
            ? (currentIndex + 1) % focusable.length
            : (currentIndex <= 0 ? focusable.length : currentIndex) - 1;
    event.preventDefault();
    focusable[nextIndex]?.focus();
  };

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t`Switch chat, currently ${title}`}
          aria-expanded={open}
          aria-haspopup="dialog"
          className={cn(
            "focus-ring flex w-fit min-w-0 max-w-full items-center gap-1.5 text-left",
            variant === "tab"
              ? // h-9 plus the grammar's mt-1 exactly fill the h-10 band, so the
                // chip's base (and its flares) sit on the band's bottom edge
                // where the page begins.
                "tab-chip-active relative h-9 px-3 [--tab-chip-surface:var(--color-background)]"
              : "-ml-1.5 rounded-md px-1.5 py-1 transition-colors hover:bg-sidebar-accent",
          )}
        >
          <PaneTitle className="min-w-0 flex-1">{title}</PaneTitle>
          <ChevronDown
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
            aria-hidden
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        {...densityPopoverCollisionProps}
        ref={contentRef}
        align="start"
        className={cn(dropdownSurfaceVariants({ measure: "catalog", page: null }), "p-0")}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const content = contentRef.current;
          const currentRow = content?.querySelector<HTMLElement>('[aria-current="page"]');
          (
            content?.querySelector<HTMLElement>("[data-switcher-search]") ??
            currentRow ??
            content?.querySelector<HTMLElement>("[data-switcher-focus]")
          )?.focus();
          currentRow?.scrollIntoView({ block: "nearest" });
        }}
        onCloseAutoFocus={(event) => {
          if (focusHandoff.current) event.preventDefault();
          focusHandoff.current = false;
        }}
        onKeyDown={handleNavigationKeyDown}
      >
        {onNewChat ? (
          <div className="px-2 pt-1">
            <button
              data-switcher-focus
              type="button"
              className={cn(dropdownRowVariants(), "text-jade-text hover:bg-primary/10")}
              onClick={() => {
                focusHandoff.current = true;
                changeOpen(false);
                onNewChat();
              }}
            >
              <Plus aria-hidden />
              <Trans>New chat</Trans>
            </button>
          </div>
        ) : null}
        {showSearch ? (
          <div className="px-2 py-1">
            <div className="relative">
              <Search
                className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                data-switcher-focus
                data-switcher-search
                type="search"
                value={query}
                aria-label={t`Search chats`}
                placeholder={t`Search chats`}
                onChange={(event) => setQuery(event.target.value)}
                className={cn(dropdownSearchClass, "shadow-none")}
              />
            </div>
          </div>
        ) : null}

        <div className={cn(dropdownResultsClass, "max-h-72 px-2 py-1")}>
          {filteredThreads.length === 0 ? (
            <p className="px-2.5 py-4 text-center text-sm text-muted-foreground">
              <Trans>No matching chats</Trans>
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {visibleWorkItems.map((group) => (
                <section key={group.id} aria-label={showGroupHeaders ? group.name : undefined}>
                  {showGroupHeaders ? (
                    <h3 className={cn(sectionLabelVariants({ variant: "group" }), "mb-1 px-2")}>
                      {group.name}
                    </h3>
                  ) : null}
                  <ul className="flex flex-col gap-0.5">
                    {group.threadIds.map((id) => {
                      const thread = threadById.get(id);
                      if (!thread) return null;
                      return (
                        <ThreadSwitchItem
                          key={id}
                          thread={thread}
                          active={id === activeThreadId}
                          now={now}
                          onSelect={selectThread}
                          onRename={startRename}
                        />
                      );
                    })}
                  </ul>
                </section>
              ))}
              {visibleUngrouped.length > 0 ? (
                <ul className="flex flex-col gap-0.5">
                  {visibleUngrouped.map((thread) => (
                    <ThreadSwitchItem
                      key={thread.id}
                      thread={thread}
                      active={thread.id === activeThreadId}
                      now={now}
                      onSelect={selectThread}
                      onRename={startRename}
                    />
                  ))}
                </ul>
              ) : null}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ThreadSwitchItem({
  thread,
  active,
  now,
  onSelect,
  onRename,
}: {
  thread: ThreadListItem;
  active: boolean;
  now: number;
  onSelect: (threadId: string) => void;
  onRename?: () => void;
}) {
  const title = displayThreadTitle(thread.title);
  const rel = relativeTime(thread.updatedAt, now);
  const agentName = thread.agentName ?? "General";
  return (
    <li
      className={cn(
        dropdownRowContainerClass,
        "group flex min-w-0 items-center transition-colors",
        "hover:bg-dropdown-hover",
        active && "text-foreground",
      )}
      data-selected={active}
    >
      <button
        data-switcher-focus
        type="button"
        aria-current={active ? "page" : undefined}
        onClick={() => onSelect(thread.id)}
        className={cn(
          dropdownRowVariants({ interactive: false }),
          "flex-1",
          active ? "font-medium" : "text-ink-muted group-hover:text-foreground",
        )}
      >
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <WorkIdentity
          className="max-w-24 shrink-0 text-ink-muted"
          name={thread.agentName}
          unavailableLabel="General"
          aria-label={t`Agent: ${agentName}`}
        />
        {rel ? (
          <span className="shrink-0 text-meta font-normal tabular-nums text-ink-subtle">{rel}</span>
        ) : null}
      </button>
      {active ? (
        <IconButton
          data-switcher-focus
          size="xs"
          aria-label={t`Rename chat`}
          title={t`Rename chat`}
          onClick={onRename}
          className="mr-1 [@media(pointer:coarse)]:size-11"
        >
          <Pencil className="size-3.5" aria-hidden />
        </IconButton>
      ) : null}
    </li>
  );
}
