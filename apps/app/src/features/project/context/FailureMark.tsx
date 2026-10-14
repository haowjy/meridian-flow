/** The warning triangle a row carries when something went wrong, with its message as tooltip or label. */
import { TriangleAlert } from "lucide-react";

export function FailureMark({ message, labelled }: { message: string; labelled?: boolean }) {
  if (labelled)
    return (
      <span className="flex min-w-0 items-center gap-1 text-xs text-destructive">
        <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{message}</span>
      </span>
    );
  return (
    <span
      role="img"
      className="flex size-7 shrink-0 items-center justify-center text-destructive"
      aria-label={message}
      title={message}
    >
      <TriangleAlert aria-hidden className="size-3.5" />
    </span>
  );
}
