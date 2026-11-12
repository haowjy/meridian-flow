/**
 * ThreadSwitcherPopover — project thread navigation from the chat pane header.
 *
 * Keeps switching primary, with recency visible at a glance; rename stays
 * attached only to the active row and creation sits above the list.
 */

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ThreadListItem } from "@meridian/contracts/protocol";
import { Pencil, Plus } from "lucide-react";
import { type RefObject, useRef, useState } from "react";
import { useThreadStore } from "@/client/stores";
import { useDensityPopoverCollisionProps } from "@/components/ui/density-popover-collision";
import { dropdownSurfaceVariants } from "@/components/ui/dropdown-presentation";
import { IconButton } from "@/components/ui/icon-button";
import { ListLine, ListRow } from "@/components/ui/list-row";
import { ChooserMark } from "@/components/ui/marks";
import { Picker, PickerResults, PickerSearch, PickerSection } from "@/components/ui/picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useProjectThreadGroups } from "@/features/project/data/project-thread-groups";
import { PaneTitle } from "@/features/project/PaneTitle";
import { relativeTime } from "@/features/project/relative-time";
import { useChatNavigation } from "@/features/project/routing/chat-navigation";
import { titleChipClass } from "@/features/project/shell/tab-chip";
import { displayThreadTitle } from "@/lib/thread-title";
import { cn } from "@/lib/utils";

import { filterThreadsByTitle, shouldShowThreadSearch } from "./thread-switcher";

/* ── Switcher popover ──────────────────────────────────────────────── */

export function ThreadSwitcherPopover({
  projectId,
  activeThreadId,
  title,
  onRename,
  triggerRef,
}: {
  projectId: string;
  activeThreadId: string | null;
  title: string;
  onRename?: () => void;
  /** Where a closed rename field hands focus back. */
  triggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const { openChat: onSelectThread, openNewChat } = useChatNavigation();
  const densityPopoverCollisionProps = useDensityPopoverCollisionProps();
  const contentRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const focusHandoff = useRef(false);
  const { workItems, primaryThreads, threadById, ungroupedThreads } =
    useProjectThreadGroups(projectId);
  const now = useThreadStore((state) => state.now);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const search = query.trim();
  const filteredThreads = filterThreadsByTitle(primaryThreads, query);
  const filteredIds = new Set(filteredThreads.map((thread) => thread.id));
  const visibleWorkItems = workItems
    .map((work) => ({
      ...work,
      threadIds: work.threadIds.filter((id) => filteredIds.has(id)),
    }))
    .filter((work) => work.threadIds.length > 0);
  const visibleUngrouped = ungroupedThreads.filter((thread) => filteredIds.has(thread.id));
  const showGroupHeaders = workItems.length + (ungroupedThreads.length > 0 ? 1 : 0) > 1;
  const showSearch = shouldShowThreadSearch(primaryThreads.length);

  const changeOpen = (nextOpen: boolean) => {
    if (nextOpen) focusHandoff.current = false;
    setOpen(nextOpen);
    if (!nextOpen) setQuery("");
  };

  const selectThread = (threadId: string) => {
    focusHandoff.current = threadId !== activeThreadId;
    changeOpen(false);
    void onSelectThread(threadId);
  };

  const startRename = () => {
    focusHandoff.current = true;
    changeOpen(false);
    onRename?.();
  };

  const threadRow = (thread: ThreadListItem) => {
    const active = thread.id === activeThreadId;
    return (
      <li key={thread.id}>
        <ListRow
          density="menu"
          current={active ? "page" : false}
          onOpen={() => selectThread(thread.id)}
          title={displayThreadTitle(thread.title)}
          meta={
            <>
              <span className="font-medium">
                <span className="sr-only">
                  <Trans>Agent:</Trans>{" "}
                </span>
                {thread.agentName ?? "General"}
              </span>{" "}
              {relativeTime(thread.updatedAt, now)}
            </>
          }
          actions={
            active ? (
              <IconButton size="xs" label={t`Rename chat`} onClick={startRename} className="mr-1">
                <Pencil aria-hidden />
              </IconButton>
            ) : null
          }
        />
      </li>
    );
  };

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          aria-label={t`Switch chat, currently ${title}`}
          aria-expanded={open}
          aria-haspopup="dialog"
          className={cn("focus-ring text-left", titleChipClass("quiet"))}
        >
          <PaneTitle className="min-w-0 flex-1">{title}</PaneTitle>
          <ChooserMark />
        </button>
      </PopoverTrigger>
      <PopoverContent
        {...densityPopoverCollisionProps}
        ref={contentRef}
        align="start"
        className={cn(dropdownSurfaceVariants({ measure: "catalog" }), "text-tier-chat")}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const content = contentRef.current;
          const currentRow = content?.querySelector<HTMLElement>('[aria-current="page"]');
          (
            searchRef.current ??
            currentRow ??
            content?.querySelector<HTMLElement>("[data-list-item]")
          )?.focus();
          currentRow?.scrollIntoView({ block: "nearest" });
        }}
        onCloseAutoFocus={(event) => {
          if (focusHandoff.current) event.preventDefault();
          focusHandoff.current = false;
        }}
      >
        <Picker label={t`Switch chat`}>
          <PickerSection>
            <li>
              <ListRow
                density="menu"
                leading={<Plus className="text-muted-foreground" aria-hidden />}
                title={<Trans>New chat</Trans>}
                onOpen={() => {
                  focusHandoff.current = true;
                  changeOpen(false);
                  void openNewChat();
                }}
              />
            </li>
          </PickerSection>
          {showSearch ? (
            <PickerSearch
              ref={searchRef}
              value={query}
              onChange={setQuery}
              label={t`Search chats`}
            />
          ) : null}
          <PickerResults>
            {filteredThreads.length === 0 ? (
              <ListLine density="menu">
                {search ? <Trans>No chats match “{search}”.</Trans> : <Trans>No chats yet.</Trans>}
              </ListLine>
            ) : null}
            {visibleWorkItems.map((group) => (
              <PickerSection key={group.id} label={showGroupHeaders ? group.name : undefined}>
                {group.threadIds.map((id) => {
                  const thread = threadById.get(id);
                  return thread ? threadRow(thread) : null;
                })}
              </PickerSection>
            ))}
            {visibleUngrouped.length > 0 ? (
              <PickerSection label={showGroupHeaders ? t`Chats without a Work` : undefined}>
                {visibleUngrouped.map(threadRow)}
              </PickerSection>
            ) : null}
          </PickerResults>
        </Picker>
      </PopoverContent>
    </Popover>
  );
}
