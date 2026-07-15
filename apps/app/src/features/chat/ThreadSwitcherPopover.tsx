/**
 * ThreadSwitcherPopover — project thread navigation from the chat pane header.
 *
 * Keeps switching primary, with recency and attention visible at a glance;
 * rename stays attached only to the active row and creation stays in the footer.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ThreadAttention, ThreadListItem } from "@meridian/contracts/protocol";
import { ChevronDown, Pencil, Plus } from "lucide-react";
import { type KeyboardEvent, useState } from "react";

import { useThreadStore } from "@/client/stores";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { sectionLabelVariants } from "@/components/ui/section-label";
import { useCreateChat } from "@/features/project/chat/use-create-chat";
import { useProjectThreadGroups } from "@/features/project/data/dashboard-data";
import { PaneTitle } from "@/features/project/PaneTitle";
import { relativeTime } from "@/features/project/relative-time";
import { displayThreadTitle } from "@/lib/thread-title";
import { cn } from "@/lib/utils";

import {
  filterThreadsByTitle,
  hasOtherThreadAttention,
  shouldShowThreadSearch,
} from "./thread-switcher";

/* ── Switcher popover ──────────────────────────────────────────────── */

export function ThreadSwitcherPopover({
  projectId,
  activeThreadId,
  title,
  onSelectThread,
  onRename,
}: {
  projectId: string;
  activeThreadId: string;
  title: string;
  onSelectThread: (threadId: string) => void;
  onRename: () => void;
}) {
  const { workItems, primaryThreads, threadById, ungroupedThreads } =
    useProjectThreadGroups(projectId);
  const { createChat, creating } = useCreateChat(projectId, onSelectThread);
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
  const triggerHasAttention = hasOtherThreadAttention(primaryThreads, activeThreadId);

  const changeOpen = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) setQuery("");
  };

  const selectThread = (threadId: string) => {
    changeOpen(false);
    onSelectThread(threadId);
  };

  const startRename = () => {
    changeOpen(false);
    onRename();
  };

  const startNewChat = () => {
    changeOpen(false);
    createChat();
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
          aria-expanded={open}
          className="focus-ring -ml-1.5 flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-sidebar-accent"
        >
          <PaneTitle className="min-w-0">{title}</PaneTitle>
          {triggerHasAttention ? (
            <span
              role="img"
              aria-label={t`Another chat needs attention`}
              className="size-1.5 shrink-0 rounded-full bg-jade-text"
            />
          ) : null}
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
        align="start"
        className="flex max-h-[60vh] w-80 flex-col overflow-hidden p-0"
        onKeyDown={handleNavigationKeyDown}
      >
        {showSearch ? (
          <div className="border-b border-border-subtle p-2">
            <Input
              data-switcher-focus
              type="search"
              value={query}
              aria-label={t`Search chats`}
              placeholder={t`Search chats`}
              onChange={(event) => setQuery(event.target.value)}
              className="h-8 shadow-none"
            />
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {filteredThreads.length === 0 ? (
            <p className="px-2.5 py-4 text-center text-sm text-muted-foreground">
              <Trans>No matching chats</Trans>
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {visibleWorkItems.map((group) => (
                <section key={group.id} aria-label={showGroupHeaders ? group.name : undefined}>
                  {showGroupHeaders ? (
                    <h3 className={cn(sectionLabelVariants({ variant: "group" }), "px-2.5 py-1.5")}>
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

        <div className="border-t border-border-subtle p-1.5">
          <Button
            data-switcher-focus
            type="button"
            variant="quiet"
            className="w-full justify-start"
            disabled={creating}
            onClick={startNewChat}
          >
            <Plus aria-hidden />
            <Trans>New chat</Trans>
          </Button>
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
  onRename: () => void;
}) {
  const title = displayThreadTitle(thread.title);
  const rel = relativeTime(thread.updatedAt, now);
  return (
    <li
      className={cn(
        "group flex min-w-0 items-center rounded-md transition-colors",
        active ? "bg-primary/10 text-foreground" : "hover:bg-sidebar-accent",
      )}
    >
      <button
        data-switcher-focus
        type="button"
        aria-current={active ? "page" : undefined}
        onClick={() => onSelect(thread.id)}
        className={cn(
          "focus-ring flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm",
          active ? "font-medium" : "text-ink-muted group-hover:text-foreground",
        )}
      >
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {rel ? (
          <span className="shrink-0 text-meta font-normal tabular-nums text-ink-subtle">{rel}</span>
        ) : null}
        <AttentionDot attention={thread.attention} />
      </button>
      {active ? (
        <IconButton
          data-switcher-focus
          size="xs"
          aria-label={t`Rename chat`}
          title={t`Rename chat`}
          onClick={onRename}
          className="mr-1"
        >
          <Pencil className="size-3.5" aria-hidden />
        </IconButton>
      ) : null}
    </li>
  );
}

function AttentionDot({ attention }: { attention: ThreadAttention }) {
  if (attention === "none") return null;
  const label =
    attention === "actionRequired"
      ? t`The AI asked you a question`
      : t`New reply since you last opened`;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        attention === "actionRequired" ? "bg-status-warning" : "bg-jade-text",
      )}
    />
  );
}
