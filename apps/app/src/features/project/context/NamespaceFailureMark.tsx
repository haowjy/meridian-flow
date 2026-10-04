/**
 * The mark a document row carries when the server refused its delete or
 * rename and reconciliation put the row back. The Editor tree shows it as an
 * icon with a tooltip; the Work Files tab has room to say it in words.
 */
import { t } from "@lingui/core/macro";
import { TriangleAlert } from "lucide-react";
import type { CatalogFile } from "@/client/query/context-catalog-projection";

type NamespaceFailure = NonNullable<CatalogFile["namespaceFailure"]>;

function namespaceFailureMessage(failure: NamespaceFailure): string {
  return failure === "delete"
    ? t`Couldn't delete this document. Try again.`
    : t`Couldn't rename this document. Try again.`;
}

export function NamespaceFailureMark({
  failure,
  labelled,
}: {
  failure: NamespaceFailure;
  /** Say the failure in words beside the icon instead of in a tooltip. */
  labelled?: boolean;
}) {
  const message = namespaceFailureMessage(failure);
  if (labelled)
    return (
      <span className="flex min-w-0 items-center gap-1 text-xs text-destructive">
        <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{message}</span>
      </span>
    );
  return (
    <span
      role="img"
      className="flex size-7 shrink-0 items-center justify-center text-destructive"
      aria-label={message}
      title={message}
    >
      <TriangleAlert aria-hidden className="size-3.5" />
    </span>
  );
}
