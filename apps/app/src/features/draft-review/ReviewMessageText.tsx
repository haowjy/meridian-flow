/** Writer-facing copy for a review message; the controller emits codes, never localized text. */
import { Trans } from "@lingui/react/macro";
import { reloadNow } from "@/client/release/release";
import { ReloadWords } from "@/components/app/AppStatus";
import type { BranchCommandFailure, ServerRefusal } from "./review-command-types";

/** State answers are complete sentences; a lead line like "Couldn't apply" would misstate them. */
function answersAlone(serverCode: string | undefined): boolean {
  return serverCode === "unsynced";
}

/** What the server refused, worded here (not by the server) in the language shown now. */
function RefusalReason({ serverCode }: ServerRefusal) {
  return serverCode === "unsynced" ? <Trans>Apply couldn't be sent. Try again.</Trans> : null;
}

export function ReviewMessageText({ failure }: { failure: BranchCommandFailure }) {
  const { code, serverCode } = failure;
  switch (code) {
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
          <RefusalReason serverCode={serverCode} />
        </>
      );
    case "discard-refused":
      return (
        <>
          {answersAlone(serverCode) ? null : <Trans>Couldn't discard this draft.</Trans>}
          <RefusalReason serverCode={serverCode} />
        </>
      );
  }
}
