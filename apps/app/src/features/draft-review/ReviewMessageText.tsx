/** Writer-facing copy for a review message; the controller emits codes, never localized text. */
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import type { BranchCommandFailure, ServerRefusal } from "@/client/query/branch-command-record";
import { RemovedDocumentApplyRefusal } from "@/features/project/context/RemovedDocumentNotice";

/** The refusals the writer can act on, worded here (not by the server) from the server's code. */
function knownRefusal(serverCode: string): MessageDescriptor | undefined {
  switch (serverCode) {
    case "work_archived":
      return msg`This Work is archived. Unarchive it to apply or discard its changes.`;
    case "work_not_found":
      return msg`This Work no longer exists.`;
    case "draft_not_found":
    case "not_found":
      return msg`This draft is no longer here. It may have been applied or discarded already.`;
    case "path_taken":
      return msg`Another document is already at this name. Rename or remove it, then apply again.`;
    case "stale":
      return msg`This document changed since you opened the review. The review now shows the latest, so look again before you apply.`;
    case "whole_item":
      return msg`This change only applies together with the rest of the document. Apply the whole document instead.`;
    case "incomplete_class":
      return msg`This change belongs with others. Select all of them and try again.`;
    case "gone":
      return msg`That change is no longer in the draft.`;
    default:
      return undefined;
  }
}

/** Holds and stale answers are complete sentences; a lead line like "Couldn't apply" would misstate them. */
function answersAlone(serverCode: string | undefined): boolean {
  return serverCode === "path_taken" || serverCode === "stale" || serverCode === "deleted_live";
}

/**
 * Why the server refused, as a sentence after the lead line. A code we know is
 * worded here, in the language shown now; any other code keeps the server's own
 * text (not in our catalogs). It never decides the wording around it, which
 * comes from the failure's code. The one renderer for a whole-draft and a
 * per-change refusal.
 */
export function RefusalReason({ serverCode, serverReason, removal }: Partial<ServerRefusal>) {
  const { i18n } = useLingui();
  // Apply never revives a removed document: the record says who removed it, and nothing to retry.
  if (serverCode === "deleted_live")
    return (
      <>
        {" "}
        <RemovedDocumentApplyRefusal record={removal ?? null} />
      </>
    );
  const known = serverCode ? knownRefusal(serverCode) : undefined;
  const reason = known
    ? i18n._(known)
    : (serverReason ?? i18n._(msg`The server couldn't do that. Try again.`));
  return <> {/[.!?]$/.test(reason) ? reason : `${reason}.`}</>;
}

export function ReviewMessageText({
  failure: { code, serverCode, serverReason, removal },
}: {
  failure: BranchCommandFailure;
}) {
  switch (code) {
    case "apply-offline":
      return <Trans>Couldn't apply. Check your connection and try again.</Trans>;
    case "apply-refused":
      return (
        <>
          {answersAlone(serverCode) ? null : <Trans>Couldn't apply this draft.</Trans>}
          <RefusalReason serverCode={serverCode} serverReason={serverReason} removal={removal} />
        </>
      );
    case "apply-server-error":
      return <Trans>Couldn't apply this draft. Try again.</Trans>;
    case "apply-blocked":
      return <Trans>Apply couldn't finish</Trans>;
    case "discard-unknown":
      return (
        <Trans>
          Couldn't confirm whether this discarded. Check what is left before you try again.
        </Trans>
      );
    case "apply-unknown":
      return (
        <Trans>
          Couldn't confirm whether this applied. Check what is left before you try again.
        </Trans>
      );
    case "discard-offline":
      return <Trans>Couldn't discard. Check your connection and try again.</Trans>;
    case "discard-refused":
      return (
        <>
          <Trans>Couldn't discard this draft.</Trans>
          <RefusalReason serverCode={serverCode} serverReason={serverReason} />
        </>
      );
    case "discard-server-error":
      return <Trans>Couldn't discard this draft. Try again.</Trans>;
    case "review-failed":
      return <Trans>Couldn't open this draft. Try again.</Trans>;
  }
}
