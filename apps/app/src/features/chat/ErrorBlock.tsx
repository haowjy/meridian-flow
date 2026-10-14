import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { NoticeCard } from "@/components/app/NoticeCard";
import { Button } from "@/components/ui/button";

/**
 * - `generation` → the message was admitted and the reply failed, with or
 *   without partial output.
 * - `retry` → a failed reply's Retry never reached the server; this is its
 *   stand-in, and Retry re-sends the same request.
 * - `provider-declined` → the AI provider turned the request down; a retry
 *   may succeed once the cause is fixed.
 */
export type ErrorBlockKind = "generation" | "retry" | "provider-declined";

export type ErrorBlockProps = {
  /**
   * Whether this error is current: no visible turn follows the errored one. A failed reply
   * the writer retried is not drawn at all, so the quiet line is only for one never retried.
   * - `true` → full tinted block with icon + message.
   * - `false` → quiet historical marker: single muted line, no background.
   */
  isLatest: boolean;
  kind?: ErrorBlockKind;
  /** Retry this turn. Omit to hide the control. */
  onRetry?: () => void;
  /**
   * The server refused this turn's last Retry; the cause stays in diagnostics.
   * Shown only while the error is current: once the chat moves on, it is history.
   */
  retryRefused?: boolean;
};

/** One quiet sentence per kind; reads on its own in history, no status prefix. */
function copy(kind: ErrorBlockKind, current: boolean): string {
  switch (kind) {
    case "retry":
      return current ? t`Couldn't start the retry. Try again.` : t`Couldn't start the retry.`;
    case "provider-declined":
      return t`The AI provider turned this request down.`;
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
  retryRefused = false,
}: ErrorBlockProps) {
  if (!isLatest) {
    return <p className="text-caption text-muted-foreground">{copy(kind, false)}</p>;
  }
  return (
    <ActiveError kind={kind} onRetry={onRetry}>
      {retryRefused ? <RefusedNote /> : null}
    </ActiveError>
  );
}

function RefusedNote() {
  return (
    <p className="text-caption text-muted-foreground" data-retry-refused>
      <Trans>Couldn't retry.</Trans>
    </p>
  );
}

function ActiveError({
  kind,
  onRetry,
  children,
}: {
  kind: ErrorBlockKind;
  onRetry?: () => void;
  children: ReactNode;
}) {
  return (
    <NoticeCard tone="error" note={children}>
      <p>{copy(kind, true)}</p>
      {onRetry ? (
        <Button type="button" variant="outline" size="xs" data-reply-retry onClick={onRetry}>
          <Trans>Retry</Trans>
        </Button>
      ) : null}
    </NoticeCard>
  );
}
