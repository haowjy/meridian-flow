/**
 * draft-command-transport — carries one Apply or Discard command to its terminal answer.
 *
 * A command is one `commandId` with one frozen body. A lost request is resent as is while the claim
 * is live (the server deduplicates); a 202 is observed with backoff and on window focus until the
 * server records `done` or `blocked`; an observation that finds nothing committed (`unknown`) resends
 * the same command. The caller reads the settled body exactly as it would a 200 (contract §4.5).
 */
import type {
  DraftApplyPendingResponse,
  DraftCommandObservation,
} from "@meridian/contracts/drafts";
import { httpErrorStatus } from "@/client/api/http-client";

/** Bounded resends of a command whose request or observation was lost. */
const RESEND_DELAYS_MS = [500, 1500, 4000] as const;
const POLL_START_MS = 1000;
const POLL_MAX_MS = 30_000;

export type CommandSettlement<R> =
  | { kind: "result"; result: R }
  /** The server marked the command's batch `blocked`: terminal, never retried. */
  | { kind: "blocked" }
  /** The claim ended while the command was out; nothing is recorded for it. */
  | { kind: "revoked" };

type Observation = DraftCommandObservation | { state: "unknown" };

/** Resolves after `ms`, or when the writer returns to the window, whichever is first. */
function pause(ms: number, wakeOnFocus: boolean): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      if (wakeOnFocus) window.removeEventListener("focus", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (wakeOnFocus) window.addEventListener("focus", done);
  });
}

export async function settleCommand<R extends { status: string }>({
  send,
  observe,
  live,
}: {
  send: () => Promise<R | DraftApplyPendingResponse>;
  observe: () => Promise<Observation>;
  live: () => boolean;
}): Promise<CommandSettlement<R>> {
  let resends = 0;
  const canResend = () => resends < RESEND_DELAYS_MS.length;
  for (;;) {
    let response: R | DraftApplyPendingResponse;
    try {
      response = await send();
    } catch (error) {
      // Only a request with no HTTP answer is unknown; any answer is the server's to refuse.
      if (httpErrorStatus(error) !== undefined || !canResend()) throw error;
      await pause(RESEND_DELAYS_MS[resends++], false);
      if (!live()) return { kind: "revoked" };
      continue;
    }
    if (response.status !== "pending") return { kind: "result", result: response as R };

    let delay = POLL_START_MS;
    let resend = false;
    while (!resend) {
      await pause(delay, true);
      if (!live()) return { kind: "revoked" };
      delay = Math.min(delay * 2, POLL_MAX_MS);
      let observed: Observation;
      try {
        observed = await observe();
      } catch (error) {
        // An answered error keeps polling; a lost read sends the command again.
        if (httpErrorStatus(error) !== undefined) continue;
        if (!canResend()) throw error;
        resend = true;
        continue;
      }
      if (observed.state === "done")
        return { kind: "result", result: observed.result as unknown as R };
      if (observed.state === "blocked") return { kind: "blocked" };
      if (observed.state === "unknown") resend = true;
    }
    if (!canResend()) throw new TypeError("Draft command was not recorded");
    await pause(RESEND_DELAYS_MS[resends++], false);
    if (!live()) return { kind: "revoked" };
  }
}
