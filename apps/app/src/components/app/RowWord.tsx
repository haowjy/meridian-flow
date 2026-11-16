import { Check, TriangleAlert } from "lucide-react";
import { type ReactNode, type Ref, useEffect, useId, useRef, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { lastInputWasKeyboard, moveFocus } from "@/lib/focus-follow";
import { cn } from "@/lib/utils";

/**
 * What a row says about what happened to it, in the row's trailing place (ListRow's `notice`),
 * never on a line of its own: "Undo" in jade, or a muted word with or without a mark ("Moved
 * back", "Applied", "Deleted"). Every short word on a row whose reason is a sentence is one, so
 * a phone reaches the sentence too. Hover, keyboard focus and a long press show the sentence ("Deleted just now.
 * Undo puts it back."); a click or a tap does the word's one action, and a word with none shows
 * the sentence, which stays until the next tap elsewhere. The host decides how long the word
 * shows: until the writer's next action there, or leaving.
 */
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
  /** What happened, in one plain sentence; the button's description. */
  sentence: ReactNode;
  /** The button's name in full when the word alone doesn't say what it acts on ("Undo delete of Chapter 4"). */
  label?: string;
  /**
   * `action`: the word is a command. `done`: a fact with a check. `warning`: something came back.
   * `note`: a fact with no mark, or one the word draws itself.
   */
  tone?: "action" | "done" | "warning" | "note";
  onAction?: () => void;
  /** The action is running: the word stays, inert. */
  pending?: boolean;
  /**
   * Focus for a word the writer's own command just made, where the control they pressed is now
   * gone (a deleted row): `take` says once whether this word takes the focus; `back` names where
   * it goes once the action brings the row back.
   */
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
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          ref={(element) => {
            self.current = element;
            if (typeof ref === "function") ref(element);
            else if (ref) ref.current = element;
          }}
          type="button"
          aria-label={label}
          aria-describedby={described}
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
          {/* In a row, as in LabelNote: the outer span takes the row's text size, so the word
              sits on the name's baseline rather than centred. Anywhere else it is text-xs like
              the chips and buttons it sits among, and the line keeps its height. */}
          <span className="text-xs in-data-list-row:text-[length:inherit] in-data-list-row:leading-[inherit]">
            <span className="text-xs">{word}</span>
          </span>
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

/**
 * A row that left its list while a notice still speaks for it, and where it was: `after` names the
 * rows that came before it, nearest first.
 */
export type GoneRow<T> = { key: string; row: T; after: readonly string[] };

export type WithGone<T, G> =
  | { key: string; gone: false; row: T }
  | { key: string; gone: true; row: G };

/**
 * Puts each gone row back after the nearest row that came before it and is still shown, or first,
 * so a list doesn't close up under the writer's pointer. A row still listed is shown once, as
 * listed.
 */
export function withGone<T, G = T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  gone: readonly GoneRow<G>[],
): WithGone<T, G>[] {
  const shown: WithGone<T, G>[] = rows.map((row) => ({ row, key: keyOf(row), gone: false }));
  // Rows with no neighbour left go to the top in the order given, not each ahead of the last.
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
