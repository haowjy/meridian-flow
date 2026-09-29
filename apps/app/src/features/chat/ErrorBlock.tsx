import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { CircleAlert } from "lucide-react";
import { type ReactNode, useId } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ErrorBlockProps = {
  /**
   * Whether this error is current: no visible turn follows the errored one.
   * - `true` → full tinted block with icon + message.
   * - `false` → quiet historical marker: single muted line, no background.
   */
  isLatest: boolean;
  /**
   * - `send` → the writer's message was never admitted (failed first send).
   * - `generation` → the message was admitted and the reply failed, with or
   *   without partial output.
   * - `interrupted` → the server ended this reply during process shutdown.
   * - `retry` → a failed reply's Retry never reached the server; this is its
   *   stand-in, and Retry re-sends the same request.
   */
  kind?: "send" | "generation" | "interrupted" | "retry";
  /** Retry this turn. Omit to hide the control. */
  onRetry?: () => void;
  /** Something holds the chat: Retry stays in place but waits until it ends. */
  retryWaiting?: boolean;
  /** The server refused this turn's last Retry: the chat moved on first. */
  retryRefused?: boolean;
};

/** One quiet sentence per kind; reads on its own in history, no status prefix. */
function copy(kind: ErrorBlockProps["kind"], current: boolean): string {
  switch (kind) {
    case "send":
      return t`Couldn't send.`;
    case "retry":
      return current ? t`Couldn't start the retry. Try again.` : t`Couldn't start the retry.`;
    case "interrupted":
      return t`This reply was interrupted.`;
    default:
      return t`This response failed.`;
  }
}

/**
 * In-flow error block for a turn that ended in an error state.
 *
 * Two visual modes:
 * - **Active** (isLatest): destructive-tinted soft block with icon, plain
 *   sentence, and Retry beside it when this turn can be tried again.
 * - **Historical** (!isLatest): quiet inline muted marker.
 */
export function ErrorBlock({
  isLatest,
  kind = "generation",
  onRetry,
  retryWaiting = false,
  retryRefused = false,
}: ErrorBlockProps) {
  const note = retryRefused ? <RefusedNote /> : null;
  if (!isLatest) {
    return (
      <div className="flex flex-col gap-1">
        <p className="text-caption text-muted-foreground">{copy(kind, false)}</p>
        {note}
      </div>
    );
  }
  return (
    <ActiveError kind={kind} onRetry={onRetry} retryWaiting={retryWaiting}>
      {note}
    </ActiveError>
  );
}

function RefusedNote() {
  return (
    <p className="text-caption text-muted-foreground" data-retry-refused>
      <Trans>Couldn't retry. Something else started in this chat first.</Trans>
    </p>
  );
}

function ActiveError({
  kind,
  onRetry,
  retryWaiting,
  children,
}: {
  kind: ErrorBlockProps["kind"];
  onRetry?: () => void;
  retryWaiting: boolean;
  children: ReactNode;
}) {
  const waitId = useId();
  return (
    <Alert
      variant="destructive"
      className={cn(
        "border-destructive-border bg-destructive-tint shadow-none",
        "rounded-field px-[var(--chat-card-pad-x)] py-[var(--chat-card-pad-y)]",
      )}
    >
      <CircleAlert className="text-destructive" aria-hidden />
      <AlertDescription className="text-compact text-ink-muted">
        <div className="flex flex-wrap items-center gap-x-[var(--chat-space-block)] gap-y-1">
          <p>{copy(kind, true)}</p>
          {onRetry ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              // aria-disabled, not disabled: the button keeps its place and
              // focus while the chat is busy, and reads its wait note with it.
              aria-disabled={retryWaiting || undefined}
              aria-describedby={retryWaiting ? waitId : undefined}
              className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:border-border aria-disabled:hover:bg-background aria-disabled:hover:text-foreground"
              data-reply-retry
              onClick={() => {
                if (!retryWaiting) onRetry();
              }}
            >
              <Trans>Retry</Trans>
            </Button>
          ) : null}
        </div>
        {onRetry && retryWaiting ? (
          <p id={waitId} className="text-caption text-muted-foreground">
            <Trans>You can retry when this chat is free.</Trans>
          </p>
        ) : null}
        {children}
      </AlertDescription>
    </Alert>
  );
}
