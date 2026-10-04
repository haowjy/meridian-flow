/** Writer-facing copy for a review message code; the controller emits codes, never localized text. */
import { Trans } from "@lingui/react/macro";
import type { InlineReviewMessageCode } from "./draft-review-session";

export function ReviewMessageText({ code }: { code: InlineReviewMessageCode }) {
  switch (code) {
    case "apply-failed":
      return <Trans>Couldn't apply. Check your connection and try again.</Trans>;
    case "apply-unknown":
      return (
        <Trans>
          Couldn't confirm whether this applied. It will update when you're back online.
        </Trans>
      );
    case "discard-offline":
      return <Trans>Couldn't discard. Check your connection and try again.</Trans>;
    case "discard-failed":
      return <Trans>Couldn't discard. Try again.</Trans>;
  }
}
