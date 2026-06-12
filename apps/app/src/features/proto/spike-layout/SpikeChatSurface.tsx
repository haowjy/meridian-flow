// @ts-nocheck
/**
 * SpikeChatSurface — minimal chat-shaped surface for Gate #3 (center ↔ dock
 * move) and Gate #1 (state survival across portal move). Holds:
 *   - a scrollable transcript (the "scroll" we prove survives the move)
 *   - a draft textarea (the "input state" that survives the move)
 *
 * It is intentionally tiny. The point of the gate is the *identity* of this
 * DOM subtree — proven by reverse-portal — not its product polish.
 *
 * Gate #6 mount probe is honored: `onMount` fires once when this surface is
 * first painted; if it ever fires twice the gate fails.
 */
import { useEffect, useState } from "react";

const SEED_TURNS = [
  {
    role: "system",
    text: "Spike chat surface — type below; this draft must survive a layout-mode toggle without remount.",
  },
  { role: "user", text: "Show me a typed message that survives the move." },
  {
    role: "assistant",
    text: "Hi! Anything you type into the draft below and any scroll position in this transcript must survive a center↔dock motion.",
  },
  {
    role: "user",
    text: "And the SAME DOM node is portalled across slots — never reparented in React.",
  },
  {
    role: "assistant",
    text: "Right. Try scrolling to the bottom, typing in the draft, then toggling the workbench mode. State stays.",
  },
  { role: "user", text: "Filler line 1 so we have something to scroll." },
  { role: "assistant", text: "Filler line 2." },
  { role: "user", text: "Filler line 3." },
  { role: "assistant", text: "Filler line 4." },
  { role: "user", text: "Filler line 5." },
  { role: "assistant", text: "Filler line 6." },
  { role: "user", text: "Filler line 7." },
  { role: "assistant", text: "Filler line 8." },
];

export function SpikeChatSurface({ onMount }: { onMount?: () => void }) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: Gate #6 counts first mount only; onMount identity changes are not remounts.
  useEffect(() => {
    onMount?.();
  }, []);

  const [draft, setDraft] = useState("");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-card px-4 py-2 text-meta text-muted-foreground">
        <span className="uppercase tracking-wide">Chat surface</span>
        <span className="font-mono text-[10px] tracking-wide">identity-stable</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" data-spike-chat-scroll>
        <ul className="flex flex-col gap-3">
          {SEED_TURNS.map((turn) => (
            <li
              key={`${turn.role}:${turn.text}`}
              className={
                "max-w-[85%] rounded-2xl px-3 py-2 text-body leading-6 " +
                (turn.role === "user"
                  ? "self-end bg-primary text-primary-foreground"
                  : "self-start bg-muted text-foreground")
              }
            >
              {turn.text}
            </li>
          ))}
        </ul>
      </div>
      <div className="shrink-0 border-t border-border bg-card px-4 py-3">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Type a draft. It must survive a center↔dock move…"
          className="focus-ring h-16 w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-body text-foreground placeholder:text-muted-foreground"
          data-spike-chat-draft
        />
      </div>
    </div>
  );
}
