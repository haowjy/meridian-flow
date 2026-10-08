/** Writer-facing copy for a review message; the controller emits codes, never localized text. */
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import type { DraftCommandFailure, ServerRefusal } from "@/client/query/draft-command-record";

/** The refusals the writer can act on, worded here (not by the server) from the server's code. */
function knownRefusal(serverCode: string): MessageDescriptor | undefined {
  switch (serverCode) {
    case "work_archived":
      return msg`This Work is archived. Unarchive it to apply or discard its drafts.`;
    case "work_not_found":
      return msg`This Work no longer exists.`;
    case "draft_not_found":
    case "not_found":
      return msg`This draft is no longer here. It may have been applied or discarded elsewhere.`;
    default:
      return undefined;
  }
}

/**
 * Why the server refused, as a sentence after the lead line. A code we know is
 * worded here, in the language shown now; any other code keeps the server's own
 * text (not in our catalogs). It never decides the wording around it, which
 * comes from the failure's code. The one renderer for a whole-draft and a
 * per-change refusal.
 */
export function RefusalReason({ serverCode, serverReason }: Partial<ServerRefusal>) {
  const { i18n } = useLingui();
  const known = serverCode ? knownRefusal(serverCode) : undefined;
  const reason = known ? i18n._(known) : serverReason;
  if (!reason) return null;
  return <> {/[.!?]$/.test(reason) ? reason : `${reason}.`}</>;
}

export function ReviewMessageText({
  failure: { code, serverCode, serverReason },
}: {
  failure: DraftCommandFailure;
}) {
  switch (code) {
    case "apply-offline":
      return <Trans>Couldn't apply. Check your connection and try again.</Trans>;
    case "apply-refused":
      return (
        <>
          <Trans>Couldn't apply this draft.</Trans>
          <RefusalReason serverCode={serverCode} serverReason={serverReason} />
        </>
      );
    case "apply-server-error":
      return <Trans>Couldn't apply this draft. Try again.</Trans>;
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
