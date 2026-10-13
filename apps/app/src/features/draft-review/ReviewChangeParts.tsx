/**
 * The small pieces every surface that shows a change shares: its colour dot,
 * who made it, and why a command on it did not land. The row, the bar and the
 * phone's sheet are made of these, so a change reads the same everywhere.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ArrowUpRight } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type {
  ChangeCommandMode,
  ChangeFailureCode,
  ServerRefusal,
} from "@/client/query/draft-command-record";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
 * the change. Names stay whole; the focused bar menus names that do not fit.
 */
export function ChangeAuthor({
  attribution,
  className,
  touch = false,
  overflow,
}: {
  overflow: "menu" | "hide";
  attribution: ChangeAttribution;
  className?: string;
  touch?: boolean;
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
  return (
    <OverflowChats
      mode={overflow}
      chats={attribution.chats}
      openThread={openThread}
      touch={touch}
      className={className}
    />
  );
}

/**
 * The first chat is always named; a bare "+N" says nothing. In menu mode names
 * after the first appear only when they fit whole, the rest collapse into "+N",
 * and a first name that does not fit is truncated with an ellipsis (still a
 * working link, full title on hover). In hide mode the whole attribution
 * disappears when it is wider than its share of the row, never a bare count.
 * Overflow retains exact chat/turn links.
 */
function OverflowChats({
  mode,
  chats,
  openThread,
  touch,
  className,
}: {
  mode: "menu" | "hide";
  chats: ChangeChat[];
  openThread: (threadId: string) => void;
  touch: boolean;
  className?: string;
}) {
  const container = useRef<HTMLSpanElement>(null);
  const measurements = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(0);
  useLayoutEffect(() => {
    const host = container.current;
    const sizes = measurements.current;
    if (!host || !sizes) return;
    const measure = () => {
      const widths = Array.from(sizes.children, (child) => child.getBoundingClientRect().width);
      if (mode === "hide") {
        const width =
          widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * 6;
        setVisible(width <= (host.parentElement?.clientWidth ?? 0) * 0.45 ? chats.length : 0);
        return;
      }
      let used = 0;
      let count = 0;
      for (const width of widths) {
        const next = used + width + (count ? 6 : 0);
        // Reserve the compact overflow trigger unless this is the last name.
        if (next + (count < chats.length - 1 ? (touch ? 50 : 38) : 0) > host.clientWidth) break;
        used = next;
        count++;
      }
      setVisible(Math.max(1, count));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(mode === "hide" && host.parentElement ? host.parentElement : host);
    observer.observe(sizes);
    return () => observer.disconnect();
  }, [chats, touch, mode]);
  return (
    <span
      ref={container}
      className={cn(
        "relative flex min-w-0 overflow-hidden items-center gap-1.5 text-caption text-muted-foreground",
        mode === "menu" ? "w-full" : visible ? "w-auto shrink-0" : "w-0",
        className,
      )}
    >
      <span
        ref={measurements}
        aria-hidden
        className="pointer-events-none invisible absolute flex w-max gap-1.5"
      >
        {chats.map((chat) => (
          <span
            key={chat.threadId}
            className={cn(
              "inline-flex items-center gap-0.5 whitespace-nowrap",
              touch && "min-w-11",
            )}
          >
            <span>{displayThreadTitle(chat.title)}</span>
            <ArrowUpRight className="size-3" />
          </span>
        ))}
      </span>
      {chats.slice(0, visible).map((chat) => (
        <ChatLink
          key={chat.threadId}
          chat={chat}
          name={displayThreadTitle(chat.title)}
          fullTitle={chat.title}
          onOpenThread={openThread}
          touch={touch}
        />
      ))}
      {mode === "menu" && visible < chats.length ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t`More chats`}
              className={cn(
                "focus-ring shrink-0 rounded-sm px-1 text-primary",
                touch && "min-h-11 min-w-11",
              )}
            >
              +{chats.length - visible}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {chats.slice(visible).map((chat) => (
              <DropdownMenuItem key={chat.threadId} onSelect={() => openChat(chat, openThread)}>
                {displayThreadTitle(chat.title)}
                <ArrowUpRight aria-hidden className="size-3" />
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </span>
  );
}

function ChatLink({
  chat,
  name,
  fullTitle,
  onOpenThread,
  touch,
}: {
  chat: ChangeChat;
  name: string;
  fullTitle: string | null;
  onOpenThread: (threadId: string) => void;
  touch: boolean;
}) {
  return (
    <button
      type="button"
      title={fullTitle ?? name}
      onClick={(event) => {
        event.stopPropagation();
        openChat(chat, onOpenThread);
      }}
      className={cn(
        "focus-ring inline-flex min-w-0 shrink whitespace-nowrap items-center gap-0.5 self-stretch rounded-sm text-primary hover:underline",
        touch && "min-h-11 min-w-11",
      )}
    >
      <span className="truncate">{name}</span>
      <ArrowUpRight aria-hidden className="size-3 shrink-0" />
    </button>
  );
}

/** Open the producing turn when recorded, otherwise the chat's usual position. */
function openChat(chat: ChangeChat, openThread: (threadId: string) => void) {
  if (chat.turnId) {
    requestConversationReveal({
      kind: "turn",
      threadId: chat.threadId,
      turnId: chat.turnId,
      ...(chat.toolCallId ? { toolCallId: chat.toolCallId } : {}),
    });
  } else {
    openThread(chat.threadId);
  }
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
