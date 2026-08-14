/** Shared destination-level recovery for a failed open/read acknowledgement. */
import { Trans } from "@lingui/react/macro";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";

export function OpenAcknowledgementError({
  error,
  onRetry,
}: {
  error: Error | null;
  onRetry: () => void;
}) {
  if (!error) return null;
  return (
    <div className="border-b border-destructive/30 bg-card px-4 py-2">
      <div className="mx-auto max-w-3xl">
        <InlineErrorRow
          message={<Trans>We couldn’t save that you opened this chat.</Trans>}
          onRetry={onRetry}
        />
      </div>
    </div>
  );
}
