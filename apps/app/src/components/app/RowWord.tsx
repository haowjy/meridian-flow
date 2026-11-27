import { Check, TriangleAlert } from "lucide-react";
import { type ReactNode, type Ref, useEffect, useId, useRef, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { lastInputWasKeyboard, moveFocus } from "@/lib/focus-follow";
import { cn } from "@/lib/utils";

export function RowWord({
  word,
  sentence,
  label,
  tone = "action",
  onAction,
  pending,
  focus,
  ref,
}: {
  word: ReactNode;
  sentence?: ReactNode;
  label?: string;
  tone?: "action" | "done" | "warning" | "note";
  onAction?: () => void;
  pending?: boolean;
  focus?: { take: () => boolean; back?: () => HTMLElement | null };
  ref?: Ref<HTMLButtonElement>;
}) {
  const described = useId();
  const [open, setOpen] = useState(false);
  const self = useRef<HTMLButtonElement | null>(null);
  const press = useRef<{ timer: number; long: boolean } | null>(null);
  const endPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
  };
  const latest = useRef(focus);
  latest.current = focus;
  useEffect(() => {
    if (self.current && latest.current?.take())
      moveFocus(self.current, { ring: lastInputWasKeyboard() });
  }, []);
  const act = () => {
    if (!onAction) return;
    const word = self.current;
    const back = latest.current?.back;
    const follow = word && word === document.activeElement && back ? followFocusFrom(word) : null;
    onAction();
    if (follow && back) follow(back);
  };
  const button = (
    <button
      ref={(element) => {
        self.current = element;
        if (typeof ref === "function") ref(element);
        else if (ref) ref.current = element;
      }}
      type="button"
      aria-label={label}
      aria-describedby={sentence ? described : undefined}
      aria-disabled={pending || undefined}
      data-row-word={tone}
      className={cn(
        "focus-ring flex shrink-0 select-none items-center gap-1 rounded-sm px-1.5 [-webkit-touch-callout:none] coarse:min-h-11 coarse:min-w-11 coarse:justify-center",
        tone === "action"
          ? "font-medium text-jade-text hover:underline underline-offset-2"
          : "text-muted-foreground",
        pending && "opacity-50",
      )}
      // A long press is the phone's hover: it must not open the row's own menu or a drag.
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
        // A word with no action keeps its sentence open: Radix's close on press is skipped.
        if (!onAction) event.preventDefault();
        if (event.pointerType !== "touch") return;
        endPress();
        const held = {
          long: false,
          timer: window.setTimeout(() => {
            held.long = true;
            setOpen(true);
          }, 450),
        };
        press.current = held;
      }}
      onPointerUp={endPress}
      onPointerCancel={endPress}
      onPointerLeave={(event) => {
        endPress();
        // A finger lifting leaves the button: the sentence a press opened stays.
        if (event.pointerType === "touch") event.preventDefault();
      }}
      onClick={(event) => {
        event.stopPropagation();
        const long = press.current?.long;
        press.current = null;
        // The sentence this click keeps or opens is the word's own: Radix's close on click
        // is skipped.
        if (long || !onAction) event.preventDefault();
        if (long) return;
        if (!onAction) setOpen(true);
        else if (!pending) act();
      }}
    >
      {tone === "warning" ? (
        <TriangleAlert aria-hidden className="size-3.5 text-warning-ink" />
      ) : tone === "done" ? (
        <Check aria-hidden className="size-3.5 text-jade-text" />
      ) : null}
      <span className="text-xs in-data-list-row:text-[length:inherit] in-data-list-row:leading-[inherit]">
        <span className="text-xs">{word}</span>
      </span>
    </button>
  );
  if (!sentence) return button;
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-64">
        {sentence}
      </TooltipContent>
      <span id={described} className="sr-only">
        {sentence}
      </span>
    </Tooltip>
  );
}

/**
 * Called as an action starts, with what has the focus: returns where to send the focus once the
 * action brings its row back, which waits for the row and gives it the focus unless the writer
 * moved it meanwhile. Focus still on `from`, or on a box that held it (where the browser or a
 * dialog's trap puts it when `from` leaves), is the action's to move.
 */
export function followFocusFrom(from: Element): (back: () => HTMLElement | null) => void {
  const around = new Set<Element>();
  for (let at = from.parentElement; at; at = at.parentElement) around.add(at);
  return (back) => {
    const until = Date.now() + 3000;
    const step = () => {
      const active = document.activeElement;
      const free = active === null || active === from || around.has(active);
      if (!free) return;
      const to = back();
      if (to) moveFocus(to, { ring: lastInputWasKeyboard() });
      else if (Date.now() < until) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
}

export type GoneRow<T> = { key: string; row: T; after: readonly string[] };

export type WithGone<T, G> =
  | { key: string; gone: false; row: T }
  | { key: string; gone: true; row: G };

export function withGone<T, G = T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  gone: readonly GoneRow<G>[],
): WithGone<T, G>[] {
  const shown: WithGone<T, G>[] = rows.map((row) => ({ row, key: keyOf(row), gone: false }));
  let top = 0;
  for (const each of gone) {
    if (shown.some((item) => item.key === each.key)) continue;
    let at = -1;
    for (const key of each.after) {
      at = shown.findIndex((item) => item.key === key);
      if (at >= 0) break;
    }
    const index = at < 0 ? top : at + 1;
    if (index <= top) top++;
    shown.splice(index, 0, { row: each.row, key: each.key, gone: true });
  }
  return shown;
}
