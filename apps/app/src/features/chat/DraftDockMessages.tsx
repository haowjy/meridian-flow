/** Failure feedback held on the chat strip file. */
import { Trans } from "@lingui/react/macro";
import { RefusalReason, ReviewMessageText } from "@/features/draft-review/ReviewMessageText";
import type { DockFileFailure } from "./useDraftDock";

/** Why a command on a file (or its preview) did not land, in the strip's words. */
export function DockFailureText({
  failure,
  fileName,
}: {
  failure: DockFileFailure;
  fileName: string;
}) {
  // A failure held on the draft itself: a Review that did not open, or a draft-wide command from another surface.
  if (failure.kind === "draft") return <ReviewMessageText failure={failure.failure} />;
  const { code, mode, serverCode, serverReason } = failure.failure;
  switch (code) {
    case "stale":
      return mode === "apply" ? (
        <Trans>This chat's changes in {fileName} were updated. Check them and apply again.</Trans>
      ) : (
        <Trans>This chat's changes in {fileName} were updated. Check them and discard again.</Trans>
      );
    case "gone":
      return <Trans>Those changes are no longer in the draft.</Trans>;
    case "unknown":
      return mode === "apply" ? (
        <Trans>
          Couldn't confirm whether these applied. Check what is left before you try again.
        </Trans>
      ) : (
        <Trans>
          Couldn't confirm whether these were discarded. Check what is left before you try again.
        </Trans>
      );
    case "offline":
      return mode === "apply" ? (
        <Trans>Couldn't apply. Check your connection and try again.</Trans>
      ) : (
        <Trans>Couldn't discard. Check your connection and try again.</Trans>
      );
    case "refused":
      return (
        <>
          {mode === "apply" ? (
            <Trans>Couldn't apply this chat's changes.</Trans>
          ) : (
            <Trans>Couldn't discard this chat's changes.</Trans>
          )}
          <RefusalReason serverCode={serverCode} serverReason={serverReason} />
        </>
      );
    case "server-error":
      return mode === "apply" ? (
        <Trans>Couldn't apply this chat's changes. Try again.</Trans>
      ) : (
        <Trans>Couldn't discard this chat's changes. Try again.</Trans>
      );
  }
}
