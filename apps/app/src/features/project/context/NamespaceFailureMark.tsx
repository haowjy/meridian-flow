/**
 * The mark a document or folder row carries when the server refused its delete
 * or rename/move and reconciliation put the row back. The Editor tree shows it as an
 * icon with a tooltip; the Work Files tab has room to say it in words.
 */
import { t } from "@lingui/core/macro";
import type { CatalogDirectory, CatalogFile } from "@/client/query/context-catalog-projection";
import { FailureMark } from "./FailureMark";

type NamespaceFailure = NonNullable<
  CatalogFile["namespaceFailure"] | CatalogDirectory["namespaceFailure"]
>;

function namespaceFailureMessage(
  failure: NamespaceFailure,
  folder: boolean,
  move: boolean,
): string {
  if (failure === "delete")
    return folder
      ? t`Couldn't delete this folder. Try again.`
      : t`Couldn't delete this document. Try again.`;
  if (move) return t`Couldn't move this entry. Try again.`;
  return folder
    ? t`Couldn't rename this folder. Try again.`
    : t`Couldn't rename this document. Try again.`;
}

export function NamespaceFailureMark({
  failure,
  folder = false,
  move = false,
  labelled,
  message: customMessage,
}: {
  failure: NamespaceFailure;
  /** The failed row is a folder, not a document. */
  folder?: boolean;
  /** The refused destination changed its parent or area, not only its name. */
  move?: boolean;
  /** Say the failure in words beside the icon instead of in a tooltip. */
  labelled?: boolean;
  /** A surface may explain where its passive status can be retried. */
  message?: string;
}) {
  const message = customMessage ?? namespaceFailureMessage(failure, folder, move);
  return <FailureMark message={message} labelled={labelled} />;
}
