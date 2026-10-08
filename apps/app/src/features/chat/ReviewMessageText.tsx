/** Writer-facing copy for a review message; the controller emits codes, never localized text. */
import { Trans } from "@lingui/react/macro";
import type { DraftCommandFailure } from "@/client/query/draft-command-record";

/**
 * The reason a server gave for a refusal, as a sentence after the lead line.
 * It is the server's own text (not in our catalogs); it never decides the
 * wording around it, which comes from the failure's code.
 */
export function RefusalReason({ reason }: { reason: string | undefined }) {
  if (!reason) return null;
  return <> {/[.!?]$/.test(reason) ? reason : `${reason}.`}</>;
}

export function ReviewMessageText({ failure: { code, reason } }: { failure: DraftCommandFailure }) {
  switch (code) {
    case "apply-offline":
      return <Trans>Couldn't apply. Check your connection and try again.</Trans>;
    case "apply-refused":
      return (
        <>
          <Trans>Couldn't apply this draft.</Trans>
          <RefusalReason reason={reason} />
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
          <RefusalReason reason={reason} />
        </>
      );
    case "discard-server-error":
      return <Trans>Couldn't discard this draft. Try again.</Trans>;
    case "review-failed":
      return <Trans>Couldn't open this draft. Try again.</Trans>;
  }
}
