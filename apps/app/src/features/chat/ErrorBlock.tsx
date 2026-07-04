import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { CircleAlert, RotateCw } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

export type ErrorBlockProps = {
  /**
   * Whether this errored turn is the latest assistant turn in the thread.
   * - `true` → full tinted block with icon + message + Retry button.
   * - `false` → quiet historical marker: single muted line, no background.
   */
  isLatest: boolean;
  /** Callback fired when the user clicks Retry. Omit to hide the button. */
  onRetry?: () => void;
};

/** Plain-language error message — never surfaces raw error strings. */
const ERROR_MESSAGE = () => t`Something went wrong generating a response.`;

/**
 * In-flow error block for a turn that ended in an error state.
 *
 * Two visual modes:
 * - **Active** (isLatest): destructive-tinted soft block with icon, plain
 *   sentence, and optional Retry button. Matches Variant 1 — Bare.
 * - **Historical** (!isLatest): quiet inline muted marker.
 */
export function ErrorBlock({ isLatest, onRetry }: ErrorBlockProps) {
  if (!isLatest) {
    return <HistoricalError />;
  }
  return <ActiveError onRetry={onRetry} />;
}

function ActiveError({ onRetry }: { onRetry?: () => void }) {
  return (
    <Alert
      variant="destructive"
      className={cn(
        "mt-2 border-destructive-border bg-destructive-tint shadow-none",
        "rounded-[10px] px-[14px] py-[12px]",
      )}
    >
      <CircleAlert className="text-destructive" aria-hidden />
      <AlertDescription className="text-compact text-ink-muted">
        <p>{ERROR_MESSAGE()}</p>
        {onRetry ? (
          <div className="mt-2 flex items-center gap-2">
            <button type="button" onClick={onRetry} className="soft-button">
              <RotateCw className="size-3" aria-hidden />
              <Trans>Retry</Trans>
            </button>
          </div>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

function HistoricalError() {
  return (
    <p className="mt-2 text-caption text-muted-foreground">
      <Trans>Errored</Trans>
      <span className="mx-1">—</span>
      {ERROR_MESSAGE()}
    </p>
  );
}
