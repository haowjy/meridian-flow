/**
 * QueryErrorRow — compact inline error + Retry row for a failed React Query
 * fetch in a list/section. Pure presentational leaf; the parent supplies the
 * retry handler. Used wherever a query-backed list can fail (sidebar, panels).
 */
import { Trans } from "@lingui/react/macro";

import { Alert, AlertDescription } from "@/components/ui/alert";

type QueryErrorRowProps = {
  onRetry: () => void;
};

export function QueryErrorRow({ onRetry }: QueryErrorRowProps) {
  return (
    <Alert className="mx-2 border-0 bg-transparent px-2 py-3 shadow-none">
      <AlertDescription className="col-start-1 flex flex-col gap-2 text-sm text-destructive">
        <p>
          <Trans>Could not load. Check your connection and try again.</Trans>
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="text-button w-fit text-sm font-medium text-foreground"
        >
          <Trans>Retry</Trans>
        </button>
      </AlertDescription>
    </Alert>
  );
}
