/**
 * ChatThreadHeader — desktop chat header and thread switcher chrome. The route
 * owns thread selection; this file coordinates title resolution and inline
 * rename while the popover owns navigation presentation. Rename persists on the
 * server through the P1 command; success is announced only after confirmation.
 */
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

/**
 * Thread chrome at the top of the chat main pane (desktop project chat).
 *
 * Shows the active thread's title and a popover to switch between the
 * project's threads (grouped by work) or rename the current one inline.
 * Sits in `ChatSurface`'s `header` slot — above the scroll region, so it stays
 * fixed while messages scroll. Rename projects the title immediately and shows
 * pending/rejection on this control; switching delegates primary/dock
 * navigation to the project route.
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
type ChatThreadTitleProps = {
  projectId: string;
  /** `null` — the empty New chat: the switcher reads "New chat" and has no rename. */
  threadId: string | null;
  activeThread?: Thread | null;
  onSelectThread: (threadId: string) => void;
  /** Trigger presentation — see `ThreadSwitcherPopover`. */
  variant?: "quiet" | "tab";
};

export function ChatThreadTitle(props: ChatThreadTitleProps) {
  const openNewChat = useOpenNewChatRoute();
  if (props.threadId === null)
    return (
      <ThreadSwitcherPopover
        projectId={props.projectId}
        activeThreadId={null}
        title={t`New chat`}
        onSelectThread={props.onSelectThread}
        onNewChat={openNewChat}
        variant={props.variant}
      />
    );
  return <ExistingThreadTitle {...props} threadId={props.threadId} />;
}

function ExistingThreadTitle({
  projectId,
  threadId,
  activeThread,
  onSelectThread,
  variant,
}: ChatThreadTitleProps & { threadId: string }) {
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
