/** Renders the current chat title and thread actions. */
import { t } from "@lingui/core/macro";
import type { Thread } from "@meridian/contracts/protocol";
import { THREAD_TITLE_MAX_LENGTH } from "@meridian/contracts/protocol";
import { Loader2 } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";

import { useRenameThread } from "@/client/query/useRenameThread";
import { announce } from "@/client/stores";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { useProjectThreadGroups } from "@/features/project/data/project-thread-groups";
import { useOpenNewChatRoute } from "@/features/project/routing/ProjectNavigationContext";
import { displayThreadTitle } from "@/lib/thread-title";
import { ThreadSwitcherPopover } from "./ThreadSwitcherPopover";

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

export function ChatThreadTitle({
  projectId,
  threadId,
  activeThread,
  onSelectThread,
  variant,
}: {
  projectId: string;
  threadId: string;
  activeThread?: Thread | null;
  onSelectThread: (threadId: string) => void;
  /** Trigger presentation — see `ThreadSwitcherPopover`. */
  variant?: "quiet" | "tab";
}) {
  const openNewChat = useOpenNewChatRoute();
  const { threadById } = useProjectThreadGroups(projectId);
  const resolved = activeThread ?? threadById.get(threadId) ?? null;
  const title = displayThreadTitle(resolved?.title);
  const [editing, setEditing] = useState(false);
  const rename = useRenameThread(projectId, threadId, (confirmed) => {
    announce(t`Renamed to ${confirmed}`);
  });

  // No wrapper of its own: every host already provides a `flex min-w-0
  // flex-1 items-center` slot, and an extra block wrapper here defeats the
  // flex sizing the children rely on (the rename input must shrink with
  // the slot, not keep its intrinsic width). Pending and rejection render as
  // siblings so they stay attached to the title control.
  return (
    <>
      {editing ? (
        <RenameField
          initialTitle={title}
          onSubmit={rename.submit}
          onDone={() => setEditing(false)}
        />
      ) : (
        <ThreadSwitcherPopover
          projectId={projectId}
          activeThreadId={threadId}
          title={title}
          onSelectThread={onSelectThread}
          onNewChat={openNewChat}
          onRename={() => setEditing(true)}
          variant={variant}
        />
      )}
      {rename.pending ? (
        <Loader2
          role="status"
          aria-label={t`Saving chat title`}
          className="size-3.5 shrink-0 animate-spin text-ink-subtle"
        />
      ) : null}
      {rename.error ? (
        <InlineErrorRow message={t`Couldn't rename chat.`} onRetry={rename.retry} />
      ) : null}
    </>
  );
}

/* ── Inline rename ─────────────────────────────────────────────────── */

function RenameField({
  initialTitle,
  onSubmit,
  onDone,
}: {
  initialTitle: string;
  onSubmit: (title: string) => void;
  onDone: () => void;
}) {
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
    if (trimmed) onSubmit(trimmed);
    onDone();
  }, [onSubmit, draft, onDone]);

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
      maxLength={THREAD_TITLE_MAX_LENGTH}
      aria-label={t`Rename chat`}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={handleKeyDown}
      onBlur={commit}
      // min-w-0 beats the UA's intrinsic min-width on inputs, so flex-1 can
      // actually shrink the field to the slot instead of overflowing it.
      className="pane-title focus-ring min-w-0 flex-1 rounded-md border border-border-focus bg-background px-2 py-1 outline-none"
    />
  );
}
