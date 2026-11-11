import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * A command's one question, in the place of the controls that asked it: asked only when the
 * command can't be taken back. Focus moves to the keeping choice, so Enter keeps, and a row that
 * reveals its actions on focus keeps the question shown.
 */
export function AskOnce({
  sentence,
  keep,
  confirm,
  onKeep,
  onConfirm,
  touch = false,
  className,
}: {
  sentence: string;
  keep: string;
  confirm: string;
  onKeep(): void;
  onConfirm(): void;
  touch?: boolean;
  className?: string;
}) {
  const keeping = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    keeping.current?.focus();
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
        <button ref={keeping} type="button" className={button} onClick={onKeep}>
          {keep}
        </button>
        <button type="button" className={button} onClick={onConfirm}>
          {confirm}
        </button>
      </span>
    </span>
  );
}
