import { t } from "@lingui/core/macro";
import { X } from "lucide-react";
import type { ComponentProps, ReactNode, Ref } from "react";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";

/**
 * The line a command leaves where it happened: what was done, the way to take it back, and
 * Dismiss ("Deleted Chapter 3 · Undo · ×"). An Undo that failed takes the line's place as
 * `InlineErrorRow`. The caller owns when it shows, what Undo does and where focus goes; a
 * caller sets only the inset (`className`).
 */
export function ActionNotice({
  sentence,
  name,
  action,
  onDismiss,
  failure,
  className,
  ...rest
}: {
  sentence: string;
  /** The part of `sentence` that shortens at narrow widths, so the verb stays whole. */
  name?: string | null;
  action?: {
    label: ReactNode;
    onClick: () => void;
    pending?: boolean;
    ref?: Ref<HTMLButtonElement>;
  };
  onDismiss: () => void;
  failure?: Pick<ComponentProps<typeof InlineErrorRow>, "message" | "onRetry" | "onDismiss"> | null;
  className?: string;
} & { [data: `data-${string}`]: string | boolean | undefined }) {
  if (failure)
    return (
      <div {...rest} className={cn("min-w-0 px-2", className)}>
        <InlineErrorRow {...failure} className="px-0 py-1" />
      </div>
    );
  return (
    <div
      {...rest}
      role="status"
      className={cn(
        "flex min-h-7 coarse:min-h-11 min-w-0 items-center gap-2 px-2 py-0.5 text-xs text-muted-foreground",
        className,
      )}
    >
      <Sentence sentence={sentence} name={name ?? null} />
      {action ? (
        <button
          ref={action.ref}
          type="button"
          className="text-button shrink-0 text-xs coarse:min-h-11 coarse:min-w-11"
          disabled={action.pending}
          onClick={action.onClick}
        >
          {action.label}
        </button>
      ) : null}
      <IconButton label={t`Dismiss`} className="shrink-0" onClick={onDismiss}>
        <X aria-hidden className="size-3" />
      </IconButton>
    </div>
  );
}

function Sentence({ sentence, name }: { sentence: string; name: string | null }) {
  const at = name ? sentence.indexOf(name) : -1;
  if (!name || at < 0)
    return (
      <span className="min-w-0 flex-1 truncate" title={sentence}>
        {sentence}
      </span>
    );
  return (
    <span className="flex min-w-0 flex-1 whitespace-pre" title={sentence}>
      <span className="shrink-0">{sentence.slice(0, at)}</span>
      <span className="min-w-0 truncate">{name}</span>
      <span className="shrink-0">{sentence.slice(at + name.length)}</span>
    </span>
  );
}
