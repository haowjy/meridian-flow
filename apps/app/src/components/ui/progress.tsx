import { cn } from "@/lib/utils";

export function Progress({
  value,
  label,
  indeterminate = false,
  className,
  fillClassName,
}: {
  value?: number;
  label?: string;
  indeterminate?: boolean;
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
      className={cn("h-1.5 overflow-hidden rounded-full bg-ink-fill", className)}
    >
      <div
        className={cn(
          "h-full rounded-full bg-primary",
          indeterminate
            ? "w-[30%] animate-progress-slide motion-reduce:animate-none"
            : "transition-[width] duration-(--motion-duration-panel) ease-out",
          fillClassName,
        )}
        style={indeterminate ? undefined : { width: `${percent}%` }}
      />
    </div>
  );
}
