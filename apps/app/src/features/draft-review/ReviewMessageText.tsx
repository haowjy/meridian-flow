/** Writer-facing copy for a review message; the controller emits codes, never localized text. */
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { reloadNow } from "@/client/release/release";
import { ReloadWords } from "@/components/app/AppStatus";
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
    case "overtaken_discarded":
      return msg`This was discarded before Apply reached it. Restore it to apply it.`;
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
    case "left_out_not_on_server":
      return msg`The server didn't have this change as you saw it, so it wasn't applied. It's kept in the draft.`;
    case "left_out_not_in_draft":
      return msg`The draft didn't have this change as you saw it, so it wasn't discarded. It's kept in the draft.`;
    default:
      return undefined;
  }
}

/** State answers are complete sentences; a lead line like "Couldn't apply" would misstate them. */
function answersAlone(serverCode: string | undefined): boolean {
  return serverCode === "unsynced" || serverCode === "left_out_not_in_draft";
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

/** What an Undo of a Discard couldn't bring back, wherever it says so. */
export const leftOutSentence = (count: number) =>
  plural(count, {
    one: "# change couldn't come back: the text changed after it was discarded.",
    other: "# changes couldn't come back: the text changed after they were discarded.",
  });

export function ReviewMessageText({ failure }: { failure: BranchCommandFailure }) {
  if (failure.code === "undo-left-out") return leftOutSentence(failure.leftOut);
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
      return <Trans>Undo didn't go through. Try again.</Trans>;
    case "apply-refused":
      if (serverCode === "needs_reload")
        return (
          <>
            <Trans>Couldn't apply this draft.</Trans>{" "}
            <button type="button" className="text-button coarse:min-h-11" onClick={reloadNow}>
              <ReloadWords />
            </button>
          </>
        );
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
          {answersAlone(serverCode) ? null : <Trans>Couldn't discard this draft.</Trans>}
          <RefusalReason serverCode={serverCode} serverReason={serverReason} />
        </>
      );
    case "review-failed":
      return <Trans>Couldn't open this draft. Try again.</Trans>;
  }
}
