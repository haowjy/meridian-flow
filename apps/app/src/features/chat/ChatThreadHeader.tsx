/**
 * ChatThreadHeader — desktop chat header and thread switcher chrome. The route
 * owns thread selection; this file keeps title display, dropdown grouping, and
 * inline rename presentation in one tokenized leaf.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Thread, ThreadListItem } from "@meridian/contracts/protocol";
import { Check, ChevronDown, Pencil } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";

import { useRenameThread } from "@/client/query/useRenameThread";
import { announce } from "@/client/stores";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { sectionLabelVariants } from "@/components/ui/section-label";
import { useProjectThreadGroups } from "@/features/project/data/dashboard-data";
import { PaneTitle } from "@/features/project/PaneTitle";
import { displayThreadTitle } from "@/lib/thread-title";
import { cn } from "@/lib/utils";

/**
 * Thread chrome at the top of the chat main pane (desktop project chat).
 *
 * Shows the active thread's title and a dropdown to switch between the
 * project's threads (grouped by work) or rename the current one inline.
 * Sits in `ChatSurface`'s `header` slot — above the scroll region, so it stays
 * fixed while messages scroll. Rename is client-cache optimistic today (no
 * PATCH endpoint yet); switching calls `onSelectThread` which updates `?thread=`.
 */
export type ChatThreadHeaderProps = {
  projectId: string;
  threadId: string;
  activeThread: Thread | null;
  onSelectThread: (threadId: string) => void;
};

export function ChatThreadHeader(props: ChatThreadHeaderProps) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-3">
      <ChatThreadTitle {...props} />
    </div>
  );
}

/**
 * The thread title control on its own — switcher dropdown (with inline rename),
 * no surrounding header bar. Extracted so the project `PaneHeader` can host it
 * as the chat destination's single header. `activeThread` is optional: when the
 * caller doesn't have the resolved thread (e.g. the shell), the title resolves
 * from the project thread groups.
 */
export function ChatThreadTitle({
  projectId,
  threadId,
  activeThread,
  onSelectThread,
}: {
  projectId: string;
  threadId: string;
  activeThread?: Thread | null;
  onSelectThread: (threadId: string) => void;
}) {
  const { threadById } = useProjectThreadGroups(projectId);
  const resolved = activeThread ?? threadById.get(threadId) ?? null;
  const title = displayThreadTitle(resolved?.title);
  const [editing, setEditing] = useState(false);

  return (
    <div className="flex min-w-0 flex-1 items-center">
      <div className="min-w-0 flex-1">
        {editing ? (
          <RenameField threadId={threadId} initialTitle={title} onDone={() => setEditing(false)} />
        ) : (
          <ThreadSwitcher
            projectId={projectId}
            activeThreadId={threadId}
            title={title}
            onSelectThread={onSelectThread}
            onRename={() => setEditing(true)}
          />
        )}
      </div>
    </div>
  );
}

/* ── Switcher dropdown ─────────────────────────────────────────────── */

function ThreadSwitcher({
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
  const { workItems, threadById, ungroupedThreads } = useProjectThreadGroups(projectId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        type="button"
        className="focus-ring -ml-1.5 flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-sidebar-accent"
      >
        <PaneTitle className="min-w-0">{title}</PaneTitle>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[60vh] w-72 overflow-y-auto">
        <DropdownMenuItem onSelect={onRename}>
          <Pencil className="size-3.5" aria-hidden />
          <Trans>Rename</Trans>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className={sectionLabelVariants({ variant: "group" })}>
          <Trans>Switch chat</Trans>
        </DropdownMenuLabel>
        {workItems.map((group) => (
          <div key={group.id}>
            <DropdownMenuLabel className={sectionLabelVariants({ variant: "group" })}>
              {group.name}
            </DropdownMenuLabel>
            {group.threadIds.map((id) => {
              const thread = threadById.get(id);
              if (!thread) return null;
              return (
                <ThreadSwitchItem
                  key={id}
                  thread={thread}
                  active={id === activeThreadId}
                  onSelect={onSelectThread}
                />
              );
            })}
          </div>
        ))}
        {ungroupedThreads.map((thread) => (
          <ThreadSwitchItem
            key={thread.id}
            thread={thread}
            active={thread.id === activeThreadId}
            onSelect={onSelectThread}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ThreadSwitchItem({
  thread,
  active,
  onSelect,
}: {
  thread: ThreadListItem;
  active: boolean;
  onSelect: (threadId: string) => void;
}) {
  return (
    <DropdownMenuItem
      onSelect={() => onSelect(thread.id)}
      className={cn(active && "bg-primary/10 font-medium text-foreground")}
    >
      <span className="min-w-0 flex-1 truncate">{displayThreadTitle(thread.title)}</span>
      {active ? <Check className="size-3.5 shrink-0 text-primary" aria-hidden /> : null}
    </DropdownMenuItem>
  );
}

/* ── Inline rename ─────────────────────────────────────────────────── */

function RenameField({
  threadId,
  initialTitle,
  onDone,
}: {
  threadId: string;
  initialTitle: string;
  onDone: () => void;
}) {
  const renameThread = useRenameThread();
  const [draft, setDraft] = useState(initialTitle);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const closedRef = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  const commit = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    const trimmed = draft.trim();
    if (trimmed) {
      renameThread(threadId, trimmed);
      announce(t`Renamed to ${trimmed}`);
    }
    onDone();
  }, [renameThread, draft, onDone, threadId]);

  const cancel = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    onDone();
  }, [onDone]);

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  }

  return (
    <input
      ref={inputRef}
      type="text"
      value={draft}
      aria-label={t`Rename thread`}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={handleKeyDown}
      onBlur={commit}
      className="pane-title focus-ring min-w-0 flex-1 rounded-md border border-border-focus bg-background px-2 py-1 outline-none"
    />
  );
}
