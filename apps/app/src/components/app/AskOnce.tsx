import { useEffect, useRef } from "react";
import { focusIsFree, lastInputWasKeyboard, moveFocus } from "@/lib/focus-follow";
import { cn } from "@/lib/utils";

/**
 * A command's one question, in the place of the controls that asked it: asked only when the
 * command can't be taken back. Focus moves to the keeping choice, so Enter keeps, and a row that
 * reveals its actions on focus keeps the question shown. Keeping gives the focus back to the
 * control that asked, or to `returnFocus()` when the question took that control's place.
 */
export function AskOnce({
  sentence,
  keep,
  confirm,
  onKeep,
  onConfirm,
  returnFocus,
  touch = false,
  className,
}: {
  sentence: string;
  keep: string;
  confirm: string;
  onKeep(): void;
  onConfirm(): void;
  returnFocus?: () => HTMLElement | null | undefined;
  touch?: boolean;
  className?: string;
}) {
  const keeping = useRef<HTMLButtonElement>(null);
  const kept = useRef(false);
  const back = useRef(returnFocus);
  back.current = returnFocus;
  useEffect(() => {
    const asked = document.activeElement;
    keeping.current?.focus();
    return () => {
      if (!kept.current || !focusIsFree()) return;
      // The control that asked may be gone, or hidden again now that its row lost the focus.
      for (const target of [asked, back.current?.()]) {
        if (!(target instanceof HTMLElement) || !target.isConnected) continue;
        moveFocus(target, { ring: lastInputWasKeyboard() });
        if (document.activeElement === target) return;
      }
    };
  }, []);
  const button = cn("text-button text-xs", touch ? "min-h-11" : "coarse:min-h-11");
  return (
    <span
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-caption text-muted-foreground",
        className,
      )}
    >
      <span className="min-w-0">{sentence}</span>
      <span className="flex shrink-0 items-center gap-2">
        <button
          ref={keeping}
          type="button"
          className={button}
          onClick={() => {
            kept.current = true;
            onKeep();
          }}
        >
          {keep}
        </button>
        <button type="button" className={button} onClick={onConfirm}>
          {confirm}
        </button>
      </span>
    </span>
  );
}
