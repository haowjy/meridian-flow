/**
 * The small pieces every surface that shows a change shares: its colour dot,
 * who made it, and why a command on it did not land. The row, the bar and the
 * phone's sheet are made of these, so a change reads the same everywhere.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ArrowUpRight } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { bylineView } from "./review-attribution";
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
 * whose writes made it, side by side. Nothing when the draft cannot say. A link opens its chat beside the
 * change and never also acts on the change; a subagent's link opens the spawn row in the chat that
 * launched it. Names stay whole; the focused bar menus names that do not fit, and the row hides them
 * all but never "You".
 */
export function ChangeAuthor({
  change,
  className,
  touch = false,
  overflow,
}: {
  overflow: "menu" | "hide";
  change: Pick<ReviewChange, "byline" | "edits">;
  className?: string;
  touch?: boolean;
}) {
  const openThread = useOpenChatThread();
  const { you: writer, chats } = useMemo(() => bylineView(change), [change.byline, change.edits]);
  const links = openThread ? chats : [];
  if (!writer && links.length === 0) return null;
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-caption text-muted-foreground",
        overflow === "menu" && "w-full",
        className,
      )}
    >
      {writer ? (
        <span className="shrink-0 whitespace-nowrap">
          <Trans>You</Trans>
        </span>
      ) : null}
      {openThread && links.length > 0 ? (
        <OverflowChats
          mode={overflow}
          writer={writer}
          chats={links}
          openThread={openThread}
          touch={touch}
        />
      ) : null}
    </span>
  );
}

const chatName = (chat: ChatRef) => displayThreadTitle(chat.title);

/** The link's accessible label: a subagent's change names its task beside the conversation it opens. */
const chatLabel = (chat: ChatRef) =>
  chat.subagentTitle
    ? t`Open ${displayThreadTitle(chat.subagentTitle)} in ${chatName(chat)}`
    : t`Open the chat that wrote this change`;

/** Measure whole names, never partial names. Overflow retains exact chat/turn links. */
function OverflowChats({
  mode,
  writer,
  chats,
  openThread,
  touch,
}: {
  mode: "menu" | "hide";
  writer: boolean;
  chats: readonly ChatRef[];
  openThread: (threadId: string) => void;
  touch: boolean;
}) {
  const container = useRef<HTMLSpanElement>(null);
  const measurements = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(0);
  useLayoutEffect(() => {
    const host = container.current;
    const sizes = measurements.current;
    if (!host || !sizes) return;
    // "You" sits outside the names: hide mode collapses only these links, and the menu measures after it.
    const row = host.parentElement;
    const measure = () => {
      const widths = Array.from(sizes.children, (child) => child.getBoundingClientRect().width);
      if (mode === "hide") {
        const lead = row
          ? row.getBoundingClientRect().width - host.getBoundingClientRect().width
          : 0;
        const names =
          widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * 6;
        const room = (row?.parentElement?.clientWidth ?? 0) * 0.45;
        setVisible(lead + names + (writer ? 6 : 0) <= room ? chats.length : 0);
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
    observer.observe(mode === "hide" && row?.parentElement ? row.parentElement : host);
    observer.observe(sizes);
    return () => observer.disconnect();
  }, [chats, writer, touch, mode]);
  return (
    <span
      ref={container}
      className={cn(
        "relative flex min-w-0 items-center gap-1.5 overflow-hidden",
        mode === "menu" ? "flex-1" : visible ? "w-auto shrink-0" : "w-0",
      )}
    >
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
      {chats.slice(0, visible).map((chat) => (
        <ChatLink key={chatKey(chat)} chat={chat} onOpenThread={openThread} touch={touch} />
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
              <DropdownMenuItem
                key={chatKey(chat)}
                title={chat.subagentTitle}
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
}: {
  chat: ChatRef;
  onOpenThread: (threadId: string) => void;
  touch: boolean;
}) {
  return (
    <button
      type="button"
      title={chat.subagentTitle ? displayThreadTitle(chat.subagentTitle) : chatLabel(chat)}
      aria-label={chat.subagentTitle ? chatLabel(chat) : undefined}
      onClick={(event) => {
        event.stopPropagation();
        openChat(chat, onOpenThread);
      }}
      className={cn(
        "focus-ring inline-flex shrink-0 whitespace-nowrap items-center gap-0.5 self-stretch rounded-sm text-primary hover:underline",
        touch && "min-h-11 min-w-11",
      )}
    >
      <span>{chatName(chat)}</span>
      <ArrowUpRight aria-hidden className="size-3 shrink-0" />
    </button>
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
