import { Check, TriangleAlert } from "lucide-react";
import { type ReactNode, type Ref, useId, useRef, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * What a sidebar row says about what just happened to it, in the row's trailing place (ListRow's
 * `notice`), never on a line of its own: "Undo" in jade, or a muted word with a mark ("Moved
 * back", "Applied"). Hover, keyboard focus and a long press show the sentence ("Deleted just now.
 * Undo puts it back."); a click or a tap does the word's one action, and a word with none shows
 * the sentence. The host decides how long it shows: until the writer's next action there, or
 * leaving.
 */
export function RowWord({
  word,
  sentence,
  label,
  tone = "action",
  onAction,
  pending,
  ref,
}: {
  word: ReactNode;
  /** What happened, in one plain sentence; the button's description. */
  sentence: ReactNode;
  /** The button's name in full when the word alone doesn't say what it acts on ("Undo delete of Chapter 4"). */
  label?: string;
  /** `action`: the word is a command. `done`: a fact with a check. `warning`: something came back. */
  tone?: "action" | "done" | "warning";
  onAction?: () => void;
  /** The action is running: the word stays, inert. */
  pending?: boolean;
  ref?: Ref<HTMLButtonElement>;
}) {
  const described = useId();
  const [open, setOpen] = useState(false);
  const press = useRef<{ timer: number; long: boolean } | null>(null);
  const endPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
  };
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          ref={ref}
          type="button"
          aria-label={label}
          aria-describedby={described}
          aria-disabled={pending || undefined}
          data-row-word={tone}
          className={cn(
            "focus-ring flex shrink-0 select-none items-center gap-1 rounded-sm px-1.5 text-xs [-webkit-touch-callout:none] coarse:min-h-11 coarse:min-w-11 coarse:justify-center",
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
          onPointerLeave={endPress}
          onClick={(event) => {
            event.stopPropagation();
            if (press.current?.long) {
              press.current = null;
              return;
            }
            press.current = null;
            if (pending) return;
            if (onAction) onAction();
            else setOpen((shown) => !shown);
          }}
        >
          {tone === "warning" ? (
            <TriangleAlert aria-hidden className="size-3.5 text-warning-ink" />
          ) : tone === "done" ? (
            <Check aria-hidden className="size-3.5 text-jade-text" />
          ) : null}
          {word}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-64">
        {sentence}
      </TooltipContent>
      <span id={described} className="sr-only">
        {sentence}
      </span>
    </Tooltip>
  );
}

/** A row's name struck through: what it names is gone, and its notice can still bring it back. */
export function GoneTitle({ children }: { children: ReactNode }) {
  return <span className="truncate text-muted-foreground line-through">{children}</span>;
}

/** Each list's rows as last shown, by the list's key: a gone row's place outlives a remount. */
const shownLists = new Map<string, readonly { key: string; row: unknown; gone: boolean }[]>();

/**
 * Keeps rows that left `rows` where they were while `held` says a notice still speaks for them,
 * so a list doesn't close up under the writer's pointer; each gone row comes back after the row
 * it last followed. `list` names the list, so the places survive the list being shown again
 * (another tab, then back). Returns every row with whether it is gone.
 */
export function useHeldRows<T>(
  list: string,
  rows: readonly T[],
  keyOf: (row: T) => string,
  held: (key: string) => boolean,
): { row: T; key: string; gone: boolean }[] {
  const last = (shownLists.get(list) ?? []) as readonly { row: T; key: string; gone: boolean }[];
  const shown = rows.map((row) => ({ row, key: keyOf(row), gone: false }));
  const present = new Set(shown.map((item) => item.key));
  let after: string | null = null;
  for (const item of last) {
    if (present.has(item.key) || !held(item.key)) {
      if (present.has(item.key)) after = item.key;
      continue;
    }
    const at: number = after === null ? 0 : shown.findIndex((each) => each.key === after) + 1;
    shown.splice(at, 0, { ...item, gone: true });
    present.add(item.key);
    after = item.key;
  }
  shownLists.set(list, shown);
  return shown;
}
