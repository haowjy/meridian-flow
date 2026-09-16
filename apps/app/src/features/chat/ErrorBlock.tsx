import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { CircleAlert } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ErrorBlockProps = {
  /**
   * Whether this errored turn is the latest assistant turn in the thread.
   * - `true` → full tinted block with icon + message.
   * - `false` → quiet historical marker: single muted line, no background.
   */
  isLatest: boolean;
  /** Empty working turn that never generated. Not generation-failure copy. */
  kind?: "send" | "generation";
  /** Retry this turn with the same ids. Omit to hide the control. */
  onRetry?: () => void;
};

function errorCopy(kind: ErrorBlockProps["kind"]): string {
  return kind === "send" ? t`Couldn't send.` : t`Something went wrong generating a response.`;
}

/**
 * In-flow error block for a turn that ended in an error state.
 *
 * Two visual modes:
 * - **Active** (isLatest): destructive-tinted soft block with icon, plain
 *   sentence, and Retry when this turn can be resubmitted.
 * - **Historical** (!isLatest): quiet inline muted marker.
 */
export function ErrorBlock({ isLatest, kind = "generation", onRetry }: ErrorBlockProps) {
  if (!isLatest) {
    return <HistoricalError kind={kind} />;
  }
  return <ActiveError kind={kind} onRetry={onRetry} />;
}

function ActiveError({ kind, onRetry }: { kind: ErrorBlockProps["kind"]; onRetry?: () => void }) {
  return (
    <Alert
      variant="destructive"
      className={cn(
        "mt-2 border-destructive-border bg-destructive-tint shadow-none",
        "rounded-field px-3.5 py-3",
      )}
    >
      <CircleAlert className="text-destructive" aria-hidden />
      <AlertDescription className="text-compact text-ink-muted">
        <p>{errorCopy(kind)}</p>
        {onRetry ? (
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={onRetry}>
            <Trans>Retry</Trans>
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

function HistoricalError({ kind }: { kind: ErrorBlockProps["kind"] }) {
  return (
    <p className="mt-2 text-caption text-muted-foreground">
      <Trans>Errored.</Trans> {errorCopy(kind)}
    </p>
  );
}
