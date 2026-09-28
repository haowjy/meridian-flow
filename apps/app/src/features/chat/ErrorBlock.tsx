import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { CircleAlert } from "lucide-react";

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
   */
  kind?: "send" | "generation";
  /** Retry this turn with the same ids. Omit to hide the control. */
  onRetry?: () => void;
};

function activeCopy(kind: ErrorBlockProps["kind"]): string {
  return kind === "send" ? t`Couldn't send.` : t`Something went wrong generating a response.`;
}

/** One quiet sentence per kind; reads on its own in history, no status prefix. */
function historicalCopy(kind: ErrorBlockProps["kind"]): string {
  return kind === "send" ? t`Couldn't send.` : t`This response failed.`;
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
        "border-destructive-border bg-destructive-tint shadow-none",
        "rounded-field px-[var(--chat-card-pad-x)] py-[var(--chat-card-pad-y)]",
      )}
    >
      <CircleAlert className="text-destructive" aria-hidden />
      <AlertDescription className="text-compact text-ink-muted">
        <p>{activeCopy(kind)}</p>
        {onRetry ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-[var(--chat-space-block)]"
            onClick={onRetry}
          >
            <Trans>Retry</Trans>
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

function HistoricalError({ kind }: { kind: ErrorBlockProps["kind"] }) {
  return <p className="text-caption text-muted-foreground">{historicalCopy(kind)}</p>;
}
