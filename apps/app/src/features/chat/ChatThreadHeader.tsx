/**
 * ChatThreadHeader — desktop chat header and thread switcher chrome. The route
 * owns thread selection; this file coordinates title resolution and inline
 * rename while the popover owns navigation presentation.
 */
import { t } from "@lingui/core/macro";
import type { Thread } from "@meridian/contracts/protocol";
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";

import { useRenameThread } from "@/client/query/useRenameThread";
import { announce } from "@/client/stores";
import { useProjectThreadGroups } from "@/features/project/data/dashboard-data";
import { displayThreadTitle } from "@/lib/thread-title";

import { ThreadSwitcherPopover } from "./ThreadSwitcherPopover";

/**
 * Thread chrome at the top of the chat main pane (desktop project chat).
 *
 * Shows the active thread's title and a popover to switch between the
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
 * The thread title control on its own — switcher popover (with inline rename),
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
          <ThreadSwitcherPopover
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
      aria-label={t`Rename chat`}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={handleKeyDown}
      onBlur={commit}
      className="pane-title focus-ring min-w-0 flex-1 rounded-md border border-border-focus bg-background px-2 py-1 outline-none"
    />
  );
}
