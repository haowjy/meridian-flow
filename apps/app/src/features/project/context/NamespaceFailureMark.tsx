/**
 * The mark a document or folder row carries when the server dropped its creation and the row
 * went back. The Editor tree shows it as an icon with a tooltip; the
 * identity bar says it in words. The server's reason follows the sentence, in its own words.
 */
import { t } from "@lingui/core/macro";
import { TriangleAlert } from "lucide-react";

function namespaceFailureMessage(folder: boolean, reason: string | undefined): string {
  const said = folder
    ? t`This folder couldn't be created where you put it.`
    : t`This document couldn't be created where you put it.`;
  return `${said} ${reason ?? t`Try another place.`}`;
}

export function NamespaceFailureMark({
  folder = false,
  labelled,
  message: customMessage,
  reason,
}: {
  /** The failed row is a folder, not a document. */
  folder?: boolean;
  /** Say the failure in words beside the icon instead of in a tooltip. */
  labelled?: boolean;
  /** A surface may explain where its passive status can be retried. */
  message?: string;
  /** The server's reason for the drop. */
  reason?: string;
}) {
  const message = customMessage ?? namespaceFailureMessage(folder, reason);
  return <FailureMark message={message} labelled={labelled} />;
}

function FailureMark({ message, labelled }: { message: string; labelled?: boolean }) {
  if (labelled)
    return (
      <span className="flex min-w-0 items-start gap-1 text-xs text-destructive">
        <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0">{message}</span>
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
