/**
 * Progress: a track and a fill with `role="progressbar"`. Determinate by
 * default; `indeterminate` slides a short fill (static under reduced motion).
 * The billing usage bar and the import status share it.
 */
import { cn } from "@/lib/utils";

export function Progress({
  value,
  label,
  indeterminate = false,
  className,
  fillClassName,
}: {
  /** 0 to 100; ignored when indeterminate. */
  value?: number;
  /** Names the bar for assistive technology. */
  label?: string;
  indeterminate?: boolean;
  /** Height and margin; the track is `bg-muted` and rounded. */
  className?: string;
  fillClassName?: string;
}) {
  const percent = Math.min(100, Math.max(0, value ?? 0));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(percent)}
      className={cn("h-1.5 overflow-hidden rounded-full bg-muted", className)}
    >
      <div
        className={cn(
          "h-full rounded-full bg-primary",
          indeterminate
            ? "w-[30%] animate-progress-slide motion-reduce:animate-none"
            : "transition-[width] duration-300 ease-out",
          fillClassName,
        )}
        style={indeterminate ? undefined : { width: `${percent}%` }}
      />
    </div>
  );
}
