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
import { useEffect, useRef } from "react";

import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import type { InterruptResponseState } from "@/core/session/interrupt-response";

export function InterruptResponseFeedback({
  state,
  onRetry,
}: {
  state: InterruptResponseState | null;
  onRetry: () => void;
}) {
  const retryRef = useRef<HTMLButtonElement>(null);
  const failed = state?.status === "ambiguous" || state?.status === "failed";
  // Move focus to Retry only on the transition into failure, so a remount with
  // an already-failed state does not steal focus from the writer.
  const wasFailed = useRef(failed);
  useEffect(() => {
    if (failed && !wasFailed.current) retryRef.current?.focus();
    wasFailed.current = failed;
  }, [failed]);

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
      retryRef={retryRef}
    />
  );
}
