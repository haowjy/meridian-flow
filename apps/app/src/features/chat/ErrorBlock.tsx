import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { NoticeCard } from "@/components/app/NoticeCard";
import { Button } from "@/components/ui/button";
import type { RetryRefusal } from "./useRetryStandIns";

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
   * Whether this error is current: no visible turn follows the errored one. A failure shows
   * only while the writer can act on it, so a failed reply the chat moved past draws nothing
   * (but a refused Retry's card).
   */
  isLatest: boolean;
  kind?: ErrorBlockKind;
  /** Retry this turn. Omit to hide the control. */
  onRetry?: () => void;
  /**
   * The server refused this turn's last Retry; the cause stays in diagnostics. Temporary: it
   * clears at the writer's next action (another Retry, or a send) or when the next reply
   * completes (`useRetryStandIns` owns that rule). On the latest failure it is a note inside
   * its card; past it, the red card alone, with no failure line above.
   */
  retryRefused?: RetryRefusal | null;
};

function copy(kind: ErrorBlockKind): string {
  switch (kind) {
    case "retry":
      return t`Couldn't start the retry. Try again.`;
    case "provider-declined":
      return t`The AI provider turned this request down.`;
    default:
      return t`This response failed.`;
  }
}

/**
 * In-flow error block for a turn that ended in an error state: a destructive-tinted soft block
 * with icon, plain sentence, and Retry beside it when this turn can be tried again.
 */
export function ErrorBlock({
  isLatest,
  kind = "generation",
  onRetry,
  retryRefused = null,
}: ErrorBlockProps) {
  if (!isLatest) return retryRefused ? <RefusedCard refusal={retryRefused} /> : null;
  return (
    <ActiveError kind={kind} onRetry={onRetry}>
      {retryRefused ? <RefusedNote refusal={retryRefused} /> : null}
    </ActiveError>
  );
}

/** The refusal in words: the cause is named only when the server's answer says it (409). */
export function retryRefusedCopy(refusal: RetryRefusal): string {
  return refusal === "another-reply"
    ? t`Couldn't retry. Another reply started first.`
    : t`Couldn't retry.`;
}

/** The refusal on its own, for a failed reply the chat moved past. */
function RefusedCard({ refusal }: { refusal: RetryRefusal }) {
  return (
    <NoticeCard tone="error">
      <p data-retry-refused>{retryRefusedCopy(refusal)}</p>
    </NoticeCard>
  );
}

/** The refusal inside the latest failure's own card. */
function RefusedNote({ refusal }: { refusal: RetryRefusal }) {
  return (
    <p className="text-caption" data-retry-refused>
      {retryRefusedCopy(refusal)}
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
      <p>{copy(kind)}</p>
      {onRetry ? (
        <Button type="button" variant="outline" size="xs" data-reply-retry onClick={onRetry}>
          <Trans>Retry</Trans>
        </Button>
      ) : null}
    </NoticeCard>
  );
}
