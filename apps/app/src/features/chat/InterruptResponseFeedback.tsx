/**
 * InterruptResponseFeedback — shared pending/error footer for ask_user cards.
 *
 * Renders the local response settlement owned by the controller/ThreadStore: a
 * quiet pending status, or the chat's failure card with Retry when the send did
 * not land. Any unconfirmed send reads as a failure because Retry is safe (the
 * server consumes a pending interrupt once). It never implies the agent
 * resolved the interrupt; that outcome stays server-confirmed and renders
 * through the card's resolved summary.
 */
import { Trans } from "@lingui/react/macro";
import { useEffect, useRef } from "react";
import { ErrorCard } from "@/components/app/ErrorCard";
import { Button } from "@/components/ui/button";
import type { InterruptResponseState } from "@/core/session/interrupt-response";

export function InterruptResponseFeedback({
  state,
  onRetry,
}: {
  state: InterruptResponseState | null;
  onRetry: () => void;
}) {
  const retryRef = useRef<HTMLButtonElement>(null);
  const failed = state?.status === "failed";
  // A card that mounts already failed (a remount, a scroll back) is restored
  // state: it takes no focus and does not announce again. Only a failure this
  // mount watched happen does; a later Retry that fails again is such a failure.
  const restored = useRef(failed);
  useEffect(() => {
    if (!failed) {
      restored.current = false;
      return;
    }
    if (!restored.current) retryRef.current?.focus();
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
    <ErrorCard announce={!restored.current}>
      <p>
        <Trans>Couldn't send your answer.</Trans>
      </p>
      <Button ref={retryRef} type="button" variant="outline" size="xs" onClick={onRetry}>
        <Trans>Retry</Trans>
      </Button>
    </ErrorCard>
  );
}
