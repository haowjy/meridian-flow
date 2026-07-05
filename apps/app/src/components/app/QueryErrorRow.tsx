/**
 * QueryErrorRow — compact inline error + Retry row for a failed React Query
 * fetch in a list/section. Pure presentational leaf; the parent supplies the
 * retry handler. Used wherever a query-backed list can fail (sidebar, panels).
 */
import { t } from "@lingui/core/macro";

import { InlineErrorRow } from "@/components/app/InlineErrorRow";

type QueryErrorRowProps = {
  onRetry: () => void;
};

export function QueryErrorRow({ onRetry }: QueryErrorRowProps) {
  return <InlineErrorRow message={t`Couldn't load. Check your connection.`} onRetry={onRetry} />;
}
