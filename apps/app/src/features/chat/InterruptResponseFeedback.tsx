/**
 * InterruptResponseFeedback — shared pending/error footer for ask_user cards.
 *
 * Renders the local response settlement owned by the controller/ThreadStore: a
 * quiet pending status, or a retryable `InlineErrorRow` for a proven or
 * ambiguous send failure. It never implies the agent resolved the interrupt;
 * that outcome stays server-confirmed and renders through the card's resolved
 * summary.
 */
import { Trans } from "@lingui/react/macro";

import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import type { InterruptResponseState } from "@/core/session/interrupt-response";

export function InterruptResponseFeedback({
  state,
  onRetry,
}: {
  state: InterruptResponseState | null;
  onRetry: () => void;
}) {
  if (!state) return null;

  if (state.status === "pending") {
    return (
      <p className="text-muted-foreground text-xs" role="status">
        <Trans>Sending your answer…</Trans>
      </p>
    );
  }

  return (
    <InlineErrorRow
      message={
        state.status === "ambiguous" ? (
          <Trans>Your answer may not have reached the agent.</Trans>
        ) : (
          <Trans>Couldn't send your answer.</Trans>
        )
      }
      onRetry={onRetry}
    />
  );
}
