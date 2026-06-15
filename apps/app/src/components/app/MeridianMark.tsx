import { cn } from "@/lib/utils";

/** Meridian wordmark mark — gradient hexagon used in the sidebar header. */
export function MeridianMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "grid size-[30px] shrink-0 place-items-center rounded-[9px] text-primary-foreground",
        "bg-gradient-mark shadow-mark",
        className,
      )}
    >
      <svg width="16" height="16" viewBox="0 0 17 17" fill="none" aria-hidden="true">
        <path
          d="M8.5 1.5 L15 5.2 V11.8 L8.5 15.5 L2 11.8 V5.2 Z"
          stroke="#fff"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
        <path
          d="M8.5 8.5 L15 5.2 M8.5 8.5 V15.5 M8.5 8.5 L2 5.2"
          stroke="#fff"
          strokeWidth="1.4"
          strokeLinejoin="round"
          opacity=".55"
        />
      </svg>
    </span>
  );
}
