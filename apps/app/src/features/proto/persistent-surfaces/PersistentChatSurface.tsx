/**
 * Lifted chat surface — one motion.div instance that glides between dock
 * (Home/Context) and center (Chat) geometries. Never unmounted by destination.
 */
import { motion } from "motion/react";

import { cn } from "@/lib/utils";

import { useSessionRegistry } from "./session-registry";
import type { ChatPlacement } from "./types";
import { useReducedMotion } from "./use-reduced-motion";

const TRANSCRIPT_LINES = Array.from({ length: 80 }, (_, i) => ({
  id: i,
  text: `Transcript line ${i + 1} — scroll me to prove position survives destination swaps.`,
}));

type PersistentChatSurfaceProps = {
  placement: ChatPlacement;
  /** When center-placed on Chat dest, leave room for doc side-peek. */
  docPeekOpen?: boolean;
};

export function PersistentChatSurface({
  placement,
  docPeekOpen = false,
}: PersistentChatSurfaceProps) {
  const reducedMotion = useReducedMotion();
  const { sessions, setScrollTop } = useSessionRegistry();
  const session = sessions.chat;

  const transition = reducedMotion
    ? { duration: 0 }
    : { type: "tween" as const, ease: [0.33, 1, 0.68, 1] as const, duration: 0.32 };

  return (
    <motion.div
      layout
      transition={transition}
      className={cn(
        "z-20 flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-card",
        placement === "center"
          ? docPeekOpen
            ? "absolute inset-y-3 left-[42%] right-3 md:right-72"
            : "absolute inset-y-3 left-3 right-3 md:left-4 md:right-72"
          : "absolute top-3 right-3 bottom-3 w-72",
      )}
      data-testid="persistent-chat-surface"
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border-subtle px-3 py-2">
        <span className="text-headline-section text-foreground">Chat (lifted)</span>
        <span
          className="rounded-full bg-status-live-bg px-2 py-0.5 font-mono text-meta text-status-live-foreground"
          data-testid="chat-ticker"
        >
          ticker: {session.ticker}
        </span>
      </header>

      <motion.div
        layoutScroll
        className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain p-3"
        onScroll={(e) => setScrollTop("chat", e.currentTarget.scrollTop)}
        ref={(el) => {
          if (el && el.scrollTop !== session.scrollTop) {
            el.scrollTop = session.scrollTop;
          }
        }}
      >
        <ul className="flex flex-col gap-2">
          {TRANSCRIPT_LINES.map((line) => (
            <li key={line.id} className="rounded-lg bg-muted px-3 py-2 text-body text-ink-muted">
              {line.text}
            </li>
          ))}
        </ul>
      </motion.div>

      <footer className="shrink-0 border-t border-border-subtle p-2">
        <div className="rounded-lg border border-border bg-background px-3 py-2 text-meta text-muted-foreground">
          Composer placeholder — same chat instance everywhere
        </div>
      </footer>
    </motion.div>
  );
}
