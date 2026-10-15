/**
 * The small pieces every surface that shows a change shares: its colour dot,
 * who made it, and why a command on it did not land. The row, the bar and the
 * phone's sheet are made of these, so a change reads the same everywhere.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ArrowUpRight } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { ChangeFailureCode, ServerRefusal } from "@/client/query/draft-command-record";
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
import { RefusalReason } from "./ReviewMessageText";
import { type ChatRef, changeTone, type ReviewChange } from "./review-model";

/** A dot in the change's colour: green for text it wrote, red for text it only removed. */
export function ChangeDot({ change, className }: { change: ReviewChange; className?: string }) {
  const tone = changeTone(change);
  return (
    <span
      aria-hidden
      data-tone={tone}
      className={cn(
        "size-2 shrink-0 rounded-full",
        tone === "add" ? "bg-primary" : "bg-destructive",
        className,
      )}
    />
  );
}

/**
 * A link to each chat whose writes overlap the change ("Pacing pass and Lore pass"). Nothing when no chat's
 * writes are known to overlap: the writer's own edits are never named. A link opens its chat beside the
 * change and never also acts on the change. Names stay whole; the focused bar menus names that do not fit.
 */
export function ChangeAuthor({
  chats,
  className,
  touch = false,
  overflow,
}: {
  overflow: "menu" | "hide";
  chats: readonly ChatRef[];
  className?: string;
  touch?: boolean;
}) {
  const openThread = useOpenChatThread();
  if (chats.length === 0 || !openThread) return null;
  return (
    <OverflowChats
      mode={overflow}
      chats={chats}
      openThread={openThread}
      touch={touch}
      className={className}
    />
  );
}

/** Measure whole names, never partial names. Overflow retains exact chat/turn links. */
function OverflowChats({
  mode,
  chats,
  openThread,
  touch,
  className,
}: {
  mode: "menu" | "hide";
  chats: readonly ChatRef[];
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
      setVisible(count);
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
            key={chat.chatId}
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
          key={chat.chatId}
          chat={chat}
          name={displayThreadTitle(chat.title)}
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
              <DropdownMenuItem key={chat.chatId} onSelect={() => openChat(chat, openThread)}>
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
  onOpenThread,
  touch,
}: {
  chat: ChatRef;
  name: string;
  onOpenThread: (threadId: string) => void;
  touch: boolean;
}) {
  return (
    <button
      type="button"
      title={t`Open the chat that wrote this change`}
      onClick={(event) => {
        event.stopPropagation();
        openChat(chat, onOpenThread);
      }}
      className={cn(
        "focus-ring inline-flex shrink-0 whitespace-nowrap items-center gap-0.5 self-stretch rounded-sm text-primary hover:underline",
        touch && "min-h-11 min-w-11",
      )}
    >
      <span>{name}</span>
      <ArrowUpRight aria-hidden className="size-3 shrink-0" />
    </button>
  );
}

/** Opens the chat at the write that made the change; with no turn known, at the chat. */
function openChat(chat: ChatRef, openThread: (threadId: string) => void) {
  if (chat.turnId) {
    requestConversationReveal({
      kind: "turn",
      threadId: chat.chatId,
      turnId: chat.turnId,
      ...(chat.toolCallId ? { toolCallId: chat.toolCallId } : {}),
    });
  } else {
    openThread(chat.chatId);
  }
}

/** Why an Apply of a change did not land, in the writer's words. */
export function ChangeFailureText({
  failure: { code, serverCode, serverReason },
}: {
  failure: { code: ChangeFailureCode } & Partial<ServerRefusal>;
}) {
  switch (code) {
    case "gone":
      return <Trans>That change is no longer in the draft.</Trans>;
    case "blocked":
      return <Trans>Apply couldn't finish</Trans>;
    case "unknown":
      return (
        <Trans>
          Couldn't confirm whether this applied. Check what is left before you try again.
        </Trans>
      );
    case "offline":
      return <Trans>Couldn't apply. Check your connection and try again.</Trans>;
    case "refused":
      return (
        <>
          <Trans>Couldn't apply this change.</Trans>
          <RefusalReason serverCode={serverCode} serverReason={serverReason} />
        </>
      );
    case "server-error":
      return <Trans>Couldn't apply this change. Try again.</Trans>;
  }
}

/** The Discard button's name. */
export function discardLabel(): string {
  return t`Discard`;
}
