/**
 * The small pieces every surface that shows a change shares: its colour dot,
 * who made it, and why a command on it did not land. The row, the bar and the
 * phone's sheet are made of these, so a change reads the same everywhere.
 */
import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ArrowUpRight } from "lucide-react";

import type { ChangeCommandMode, ChangeFailureCode } from "@/client/query/change-command-record";
import type { ServerRefusal } from "@/client/query/draft-command-record";
import { useOpenChatThread } from "@/features/chat/ChatThreadNavigation";
import { requestConversationReveal } from "@/features/chat/conversation-reveal";
import { displayThreadTitle } from "@/lib/thread-title";
import { cn } from "@/lib/utils";
import type { ChangeAttribution, ChangeChat } from "./change-attribution";
import { RefusalReason } from "./ReviewMessageText";
import type { ReviewChange, ReviewChangeTone } from "./review-changes";

const DOT_TONE: Record<ReviewChangeTone, string> = {
  ai: "bg-primary",
  writer: "bg-gold",
  removal: "bg-destructive",
  merged: "bg-muted-foreground",
  unattributed: "bg-muted-foreground/60",
};

/** A dot in the change's colour. Half green, half gold when the writer's edits are inside an AI change. */
export function ChangeDot({ change, className }: { change: ReviewChange; className?: string }) {
  const half = change.includesWriterEdits && change.tone === "ai";
  return (
    <span
      aria-hidden
      data-tone={change.tone}
      className={cn(
        "size-2 shrink-0 rounded-full",
        half
          ? "bg-[linear-gradient(90deg,var(--color-primary)_50%,var(--color-gold)_50%)]"
          : DOT_TONE[change.tone],
        className,
      )}
    />
  );
}

/**
 * "You", a link to each chat that wrote the change ("Pacing pass and Lore
 * pass"), or plain "AI" when the preview cannot say which chat. A link opens
 * its chat beside the change at the turn that wrote it and never also acts on
 * the change; the names wrap when there are many. The caller bounds the width
 * (`max-w-*`): the row gives it a line of its own, the bar caps it.
 */
export function ChangeAuthor({
  attribution,
  className,
}: {
  attribution: ChangeAttribution;
  className?: string;
}) {
  const openThread = useOpenChatThread();
  if (attribution.kind === "you") {
    return (
      <span
        className={cn(
          "shrink-0 text-caption font-medium text-[color:var(--color-review-writer-removed-foreground)]",
          className,
        )}
      >
        <Trans>You</Trans>
      </span>
    );
  }
  if (attribution.kind === "unattributed") {
    return (
      <span className={cn("shrink-0 text-caption text-muted-foreground", className)}>
        <Trans>Unattributed</Trans>
      </span>
    );
  }
  if (attribution.kind === "ai" || !openThread) {
    return (
      <span className={cn("shrink-0 text-caption text-muted-foreground", className)}>
        <Trans>AI</Trans>
      </span>
    );
  }
  // The names as the chat list shows them, so each link names what it opens.
  const parts = new Intl.ListFormat(i18n.locale || undefined, {
    style: "long",
    type: "conjunction",
  }).formatToParts(attribution.chats.map((chat) => displayThreadTitle(chat.title)));
  let next = 0;
  return (
    <span
      className={cn(
        "inline-flex min-w-0 flex-wrap items-baseline text-caption text-muted-foreground",
        className,
      )}
    >
      {parts.map((part, index) => {
        if (part.type === "literal") {
          // pre keeps the separator's spaces, which a flex item would drop.
          return (
            <span key={index} className="whitespace-pre">
              {part.value}
            </span>
          );
        }
        const chat = attribution.chats[next++];
        return (
          <ChatLink key={chat.threadId} chat={chat} name={part.value} onOpenThread={openThread} />
        );
      })}
    </span>
  );
}

function ChatLink({
  chat,
  name,
  onOpenThread,
}: {
  chat: ChangeChat;
  name: string;
  onOpenThread: (threadId: string) => void;
}) {
  return (
    <button
      type="button"
      title={t`Open the chat that wrote this change`}
      onClick={(event) => {
        event.stopPropagation();
        // Open the chat where the write happened. Without a recorded turn
        // (older data) it is the chat at its usual position.
        if (chat.turnId) {
          requestConversationReveal({
            kind: "turn",
            threadId: chat.threadId,
            turnId: chat.turnId,
            ...(chat.toolCallId ? { toolCallId: chat.toolCallId } : {}),
          });
        } else {
          onOpenThread(chat.threadId);
        }
      }}
      className="focus-ring inline-flex min-w-0 max-w-32 items-center gap-0.5 self-stretch rounded-sm text-primary hover:underline"
    >
      <span className="truncate">{name}</span>
      <ArrowUpRight aria-hidden className="size-3 shrink-0" />
    </button>
  );
}

/** Why a command on a change did not land, in the writer's words. */
export function ChangeFailureText({
  failure: { code, mode, serverCode, serverReason },
}: {
  failure: { code: ChangeFailureCode; mode: ChangeCommandMode } & Partial<ServerRefusal>;
}) {
  switch (code) {
    case "stale":
      return mode === "apply" ? (
        <Trans>This change was updated. Check it and apply again.</Trans>
      ) : (
        <Trans>This change was updated. Check it and discard again.</Trans>
      );
    case "gone":
      return <Trans>That change is no longer in the draft.</Trans>;
    case "draft-only":
      return mode === "apply" ? (
        <Trans>A new document is applied as a whole. Use Apply draft.</Trans>
      ) : (
        <Trans>A new document is discarded as a whole. Use Discard draft.</Trans>
      );
    case "unknown":
      return mode === "apply" ? (
        <Trans>
          Couldn't confirm whether this applied. Check what is left before you try again.
        </Trans>
      ) : (
        <Trans>
          Couldn't confirm whether this was discarded. Check what is left before you try again.
        </Trans>
      );
    case "offline":
      return mode === "apply" ? (
        <Trans>Couldn't apply. Check your connection and try again.</Trans>
      ) : (
        <Trans>Couldn't discard. Check your connection and try again.</Trans>
      );
    case "refused":
      return (
        <>
          {mode === "apply" ? (
            <Trans>Couldn't apply this change.</Trans>
          ) : (
            <Trans>Couldn't discard this change.</Trans>
          )}
          <RefusalReason serverCode={serverCode} serverReason={serverReason} />
        </>
      );
    case "server-error":
      return mode === "apply" ? (
        <Trans>Couldn't apply this change. Try again.</Trans>
      ) : (
        <Trans>Couldn't discard this change. Try again.</Trans>
      );
  }
}

/** The Discard button's name: it never hides that the writer's own edits go with it. */
export function discardLabel(change: ReviewChange): string {
  return change.includesWriterEdits ? t`Discard with your edits` : t`Discard`;
}
