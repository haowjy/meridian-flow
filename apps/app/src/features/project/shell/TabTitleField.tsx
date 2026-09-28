/**
 * TabTitleField — renames a pane band's active tab inside the tab itself.
 *
 * Renders in place of the tab's title text with the same `pane-title`
 * typography and the same inset, so the words do not move or resize; the field
 * is only as wide as its text. Enter or blur commits, Escape cancels.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { InlineEditInput } from "@/components/ui/inline-edit";
import { cn } from "@/lib/utils";

export function TabTitleField({
  initial,
  label,
  maxLength,
  onCommit,
  onCancel,
  className = "pane-title flex min-w-0 px-1",
}: {
  initial: string;
  label: string;
  maxLength?: number;
  /** Receives the trimmed draft; an empty or unchanged draft cancels instead. */
  onCommit: (title: string) => void;
  onCancel: () => void;
  /** Wrapper typography and inset; defaults to the pane band's title. */
  className?: string;
}) {
  const [draft, setDraft] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  const closed = useRef(false);
  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const close = (commit: boolean) => {
    if (closed.current) return;
    closed.current = true;
    const next = draft.trim();
    if (commit && next && next !== initial) onCommit(next);
    else onCancel();
  };
  return (
    <span className={className}>
      <InlineEditInput
        ref={input}
        value={draft}
        maxLength={maxLength}
        aria-label={label}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            close(true);
          } else if (event.key === "Escape") {
            event.preventDefault();
            close(false);
          }
        }}
        onBlur={() => close(true)}
      />
    </span>
  );
}

/**
 * The title chip's shell, shared by the switcher trigger and the in-tab rename
 * so renaming keeps the chip and its text exactly where they were.
 * `tab`: h-9 plus the grammar's top margin exactly fill the h-10 band, so the
 * chip's base (and its flares) sit on the band's bottom edge where the page
 * begins. `quiet`: an inactive document tab's hover, the inset pill over the
 * band's full height.
 */
export function titleChipClass(variant: "quiet" | "tab") {
  return cn(
    "flex w-fit min-w-0 max-w-full items-center gap-[var(--chat-space-inline)]",
    variant === "tab"
      ? "tab-chip-active relative h-9 px-[var(--chat-card-pad-x)] [--tab-chip-surface:var(--color-background)]"
      : "tab-chip-inactive relative -ml-2 self-stretch px-[var(--chat-card-pad-x)] [--tab-chip-surface:var(--color-background)] [@media(pointer:coarse)]:min-h-11",
  );
}
