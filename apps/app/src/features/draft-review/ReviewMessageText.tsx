/** Writer-facing copy for a review message; the controller emits codes, never localized text. */
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import type { BranchCommandFailure, ServerRefusal } from "./review-command-types";

/** The refusals the writer can act on, worded here (not by the server) from the server's code. */
function knownRefusal(serverCode: string): MessageDescriptor | undefined {
  switch (serverCode) {
    case "review_updated":
      return msg`The review updated. Choose the change again.`;
    case "unavailable":
      return msg`Apply is temporarily unavailable.`;
    case "work_not_found":
      return msg`This Work no longer exists.`;
    case "draft_not_found":
    case "not_found":
      return msg`This draft is no longer here. It may have been applied or discarded already.`;
    case "stale":
      return msg`This document changed since you opened the review. The review now shows the latest, so look again before you apply.`;
    case "overtaken_discarded":
      return msg`This was discarded before Apply reached it. Restore it to apply it.`;
    case "overtaken_applied":
      return msg`This was applied before your Discard reached it.`;
    case "overtaken_removed":
      return msg`This document was deleted before its changes could be applied.`;
    case "left_out_would_loop":
      return msg`This move would put a folder inside itself, so it wasn't applied.`;
    case "left_out_purged":
      return msg`This is no longer in the draft, so it wasn't applied.`;
    case "left_out_after_press":
      return msg`This changed after you pressed Apply, so it wasn't applied. Check it, then apply again.`;
    case "left_out_needs":
      return msg`This depends on a change that wasn't applied, so it was left out.`;
    case "left_out_changed_since":
      return msg`This draft moved on since you pressed Apply, so it wasn't applied.`;
    case "unsynced":
      return msg`Apply couldn't be sent. Try again.`;
    case "read_only":
      return msg`This draft just became read-only, so nothing was discarded. Check it, then try again.`;
    case "chat_frozen":
      return msg`This chat is in the trash, so its drafts are frozen. Restore the chat to apply them.`;
    default:
      return undefined;
  }
}

/** State answers are complete sentences; a lead line like "Couldn't apply" would misstate them. */
function answersAlone(serverCode: string | undefined): boolean {
  return serverCode === "stale" || serverCode === "unsynced";
}

/**
 * Why the server refused, as a sentence after the lead line. A code we know is
 * worded here, in the language shown now; any other code keeps the server's own
 * text (not in our catalogs). It never decides the wording around it, which
 * comes from the failure's code. The one renderer for a whole-draft and a
 * per-change refusal.
 */
function RefusalReason({ serverCode, serverReason }: Partial<ServerRefusal>) {
  const { i18n } = useLingui();
  const known = serverCode ? knownRefusal(serverCode) : undefined;
  const reason = known
    ? i18n._(known)
    : (serverReason ?? i18n._(msg`The server couldn't do that. Try again.`));
  return <> {/[.!?]$/.test(reason) ? reason : `${reason}.`}</>;
}

export function ReviewMessageText({ failure }: { failure: BranchCommandFailure }) {
  if (failure.code === "apply-left-out") {
    // One sentence per distinct reason, whichever half it explains: each says what to do.
    const codes = [...new Set(failure.lines.map((line) => line.code))];
    return codes.map((code) => (
      <span key={code} className="block">
        <RefusalReason serverCode={code} />
      </span>
    ));
  }
  const { code, serverCode, serverReason } = failure;
  switch (code) {
    case "unapply-refused":
      return <Trans>Couldn't undo this Apply. Try again.</Trans>;
    case "apply-refused":
      return (
        <>
          {answersAlone(serverCode) ? null : <Trans>Couldn't apply this draft.</Trans>}
          <RefusalReason serverCode={serverCode} serverReason={serverReason} />
        </>
      );
    case "discard-unknown":
      return (
        <Trans>
          Couldn't confirm whether this discarded. Check what is left before you try again.
        </Trans>
      );
    case "discard-refused":
      return (
        <>
          <Trans>Couldn't discard this draft.</Trans>
          <RefusalReason serverCode={serverCode} serverReason={serverReason} />
        </>
      );
    case "review-failed":
      return <Trans>Couldn't open this draft. Try again.</Trans>;
  }
}
