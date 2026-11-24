import { useEffect, useRef } from "react";
import { focusIsFree, lastInputWasKeyboard, moveFocus } from "@/lib/focus-follow";
import { cn } from "@/lib/utils";

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
        "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground",
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
