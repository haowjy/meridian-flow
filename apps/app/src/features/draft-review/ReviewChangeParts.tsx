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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useOpenChatThread } from "@/features/chat/ChatThreadNavigation";
import { requestConversationReveal } from "@/features/chat/conversation-reveal";
import { displayThreadTitle } from "@/lib/thread-title";
import { cn } from "@/lib/utils";
import { RefusalReason } from "./ReviewMessageText";
import { writerIn } from "./review-attribution";
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
 * Who made the change: the byline. "You" when the writer did (plain text, first), then a link to each chat
 * whose writes made it. Nothing when the draft cannot say. A link opens its chat at the write that made the
 * change and never also acts on the change; a subagent's link opens the spawn row in the chat that
 * launched it.
 *
 * A byline never hides its author. The first chat is always drawn: its name truncates with an ellipsis
 * and keeps its full title in its tooltip and accessible name. The chats after it go behind "+N", a menu
 * of the same links. `fit` decides how many whole names sit beside the first: the focused bar fits as
 * many as its width allows (`names`), and a list row, which gives its width to the change's text,
 * shows the first alone (`first`).
 */
export function ChangeAuthor({
  change,
  className,
  touch = false,
  fit,
}: {
  fit: "names" | "first";
  change: Pick<ReviewChange, "byline" | "chats">;
  className?: string;
  touch?: boolean;
}) {
  const openThread = useOpenChatThread();
  const writer = writerIn(change);
  const links = openThread ? change.chats : [];
  if (!writer && links.length === 0) return null;
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 text-caption text-muted-foreground",
        // A row's byline with no chat is "You" alone and keeps its width.
        fit === "names" && "w-full min-w-0",
        className,
      )}
      // A row gives the change's text its width first and the byline the rest, never less than this floor:
      // "You", a few letters of the first chat's name, and its "+N". Explicit because the names' nowrap
      // text would otherwise make the floor their full width.
      style={
        fit === "first" && links.length > 0
          ? { minWidth: bylineFloor(writer, links.length, touch) }
          : undefined
      }
    >
      {writer ? (
        <span className="shrink-0 whitespace-nowrap">
          <Trans>You</Trans>
        </span>
      ) : null}
      {openThread && links.length > 0 ? (
        <OverflowChats fit={fit} chats={links} openThread={openThread} touch={touch} />
      ) : null}
    </span>
  );
}

/** The row byline's narrowest width, in rem: the parts below, at text-caption, plus their 0.375rem gaps. */
function bylineFloor(writer: boolean, chats: number, touch: boolean): string {
  const you = writer ? 2 : 0;
  const firstName = FIRST_NAME_MIN_REM + 0.875; // the name's floor, then its arrow and the gap before it
  const more = chats > 1 ? (touch ? 3.125 : 1.75) : 0;
  return `${you + firstName + more}rem`;
}

/** How narrow the first chat's name may truncate: about six letters before the ellipsis. */
const FIRST_NAME_MIN_REM = 3.5;

const chatName = (chat: ChatRef) => displayThreadTitle(chat.title);

/** The link's tooltip: the full name, or a subagent's task beside the conversation it opens. */
const chatLabel = (chat: ChatRef) =>
  chat.subagentTitle
    ? t`Open ${displayThreadTitle(chat.subagentTitle)} in ${chatName(chat)}`
    : chatName(chat);

/** The first chat, then whole names that fit (`names`), then "+N" for the rest with their exact links. */
function OverflowChats({
  fit,
  chats,
  openThread,
  touch,
}: {
  fit: "names" | "first";
  chats: readonly ChatRef[];
  openThread: (threadId: string) => void;
  touch: boolean;
}) {
  const container = useRef<HTMLSpanElement>(null);
  const measurements = useRef<HTMLSpanElement>(null);
  const [fitted, setFitted] = useState(1);
  const measure = fit === "names" && chats.length > 1;
  useLayoutEffect(() => {
    const host = container.current;
    const sizes = measurements.current;
    if (!measure || !host || !sizes) return;
    const update = () => {
      const widths = Array.from(sizes.children, (child) => child.getBoundingClientRect().width);
      // The first name is always drawn (truncated if it must be); later names join only whole.
      let used = widths[0] ?? 0;
      let count = 1;
      for (const width of widths.slice(1)) {
        const next = used + 6 + width;
        // Reserve the compact overflow trigger unless this is the last name.
        if (next + (count < chats.length - 1 ? (touch ? 50 : 38) : 0) > host.clientWidth) break;
        used = next;
        count++;
      }
      setFitted(count);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    observer.observe(sizes);
    return () => observer.disconnect();
  }, [chats, touch, measure]);
  const visible = measure ? fitted : 1;
  return (
    <span
      ref={container}
      className={cn(
        "flex min-w-0 items-center gap-1.5",
        fit === "names" && "relative flex-1 overflow-hidden",
      )}
    >
      {measure ? (
        <span
          ref={measurements}
          aria-hidden
          className="pointer-events-none invisible absolute flex w-max gap-1.5"
        >
          {chats.map((chat) => (
            <span
              key={chatKey(chat)}
              className={cn(
                "inline-flex items-center gap-0.5 whitespace-nowrap",
                touch && "min-w-11",
              )}
            >
              <span>{chatName(chat)}</span>
              <ArrowUpRight className="size-3" />
            </span>
          ))}
        </span>
      ) : null}
      {chats.slice(0, visible).map((chat, index) => (
        <ChatLink
          key={chatKey(chat)}
          chat={chat}
          onOpenThread={openThread}
          touch={touch}
          truncate={index === 0}
        />
      ))}
      {visible < chats.length ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t`More chats`}
              onClick={(event) => event.stopPropagation()}
              className={cn(
                "focus-ring shrink-0 whitespace-nowrap rounded-sm px-1 text-primary",
                touch && "min-h-11 min-w-11",
              )}
            >
              +{chats.length - visible}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" onClick={(event) => event.stopPropagation()}>
            {chats.slice(visible).map((chat) => (
              <DropdownMenuItem
                key={chatKey(chat)}
                title={chat.subagentTitle ? chatLabel(chat) : undefined}
                onSelect={() => openChat(chat, openThread)}
              >
                {chatName(chat)}
                <ArrowUpRight aria-hidden className="size-3" />
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </span>
  );
}

const chatKey = (chat: ChatRef) => `${chat.chatId}:${chat.reveal?.subagentThreadId ?? ""}`;

function ChatLink({
  chat,
  onOpenThread,
  touch,
  truncate,
}: {
  chat: ChatRef;
  onOpenThread: (threadId: string) => void;
  touch: boolean;
  /** The first name: it truncates rather than leave the byline (a row's floor keeps a few letters). */
  truncate: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-chat-link
          // The visible text is the full name, truncated only by CSS; a subagent's link names its task too.
          aria-label={chat.subagentTitle ? chatLabel(chat) : undefined}
          onClick={(event) => {
            event.stopPropagation();
            openChat(chat, onOpenThread);
          }}
          className={cn(
            "focus-ring inline-flex items-center gap-0.5 self-stretch whitespace-nowrap rounded-sm text-primary hover:underline",
            truncate ? "min-w-0 shrink" : "shrink-0",
            touch && "min-h-11 min-w-11",
          )}
        >
          <span className={cn(truncate && "min-w-0 truncate")}>{chatName(chat)}</span>
          <ArrowUpRight aria-hidden className="size-3 shrink-0" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-80 break-words">{chatLabel(chat)}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Opens the chat at the write that made the change (KF14); a subagent's change opens the spawn row in the
 * conversation that launched it. With no write known (a list row), the chat.
 */
function openChat(chat: ChatRef, openThread: (threadId: string) => void) {
  const reveal = chat.reveal;
  if (!reveal) return openThread(chat.chatId);
  requestConversationReveal({
    kind: "turn",
    threadId: reveal.threadId,
    turnId: reveal.turnId,
    ...(reveal.toolCallId ? { toolCallId: reveal.toolCallId } : {}),
    ...(reveal.subagentThreadId
      ? { subagentThreadId: reveal.subagentThreadId, subagentBlock: "card" as const }
      : {}),
  });
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
