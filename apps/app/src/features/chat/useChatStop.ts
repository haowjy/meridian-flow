/**
 * useChatStop — the composer's Stop: cancel the running reply and take every waiting writer
 * message back into this tab's composer. The hand-back operation (`useHandBack`) owns the
 * lifecycle, and `handBackCards` decides its failure card; this hook presses it and keeps the
 * Stop control's state (`StopStatus`), which only this tab has: other tabs see the record,
 * never Stopping.
 *
 * The press is `pending` (Stopping at once). A confirmed answer that names a cancelled execution
 * is `stopping` while the held record still shows that execution; any other answer clears with
 * the answer. A Stop command that still owes a card is `failed`, which stays until it resolves
 * or is dismissed, even after the chat goes idle, so the retry stays reachable. Pressing a
 * failed Stop replays the same request.
 */
import { t } from "@lingui/core/macro";
import { type StopStatus, stopStatus } from "@meridian/thread-client";
import { useCallback, useRef, useState } from "react";
import { announce, announceError, useRunState } from "@/client/stores";
import type { ChatHandBack } from "./useHandBack";

export type ChatStop = {
  status: StopStatus;
  /** Press Stop. While pending or stopping it does nothing; after a failure it replays. */
  stop: () => void;
};

export function useChatStop(input: { threadId: string; handBack: ChatHandBack }): ChatStop {
  const { threadId, handBack } = input;
  const { operation, unresolved, settle } = handBack;
  const view = useRunState(threadId);
  const latest = useRef({ view, unresolved });
  latest.current = { view, unresolved };
  const [command, setCommand] = useState<{
    request: "idle" | "pending";
    cancelledExecutionId: string | null;
  }>({ request: "idle", cancelledExecutionId: null });

  const base = stopStatus(view, command);
  const failed = unresolved.some((entry) => entry.commandKind === "stop");
  const status: StopStatus = base === "idle" && failed ? "failed" : base;
  const pressed = useRef(status);
  pressed.current = status;

  const stop = useCallback(() => {
    // Ignored while Stopping: the request is out, or the cancel is landing.
    if (pressed.current === "pending" || pressed.current === "stopping") return;
    const { view: held, unresolved: owed } = latest.current;
    const replay = owed.find((entry) => entry.commandKind === "stop" && entry.status !== "refused");
    setCommand({ request: "pending", cancelledExecutionId: null });
    announce(t`Stopping`);
    void settle(
      replay ? operation.retry(replay.requestId) : operation.press({ kind: "stop", view: held }),
    ).then((outcome) => {
      setCommand({
        request: "idle",
        cancelledExecutionId: outcome?.kind === "confirmed" ? outcome.cancelledExecutionId : null,
      });
      if (outcome && outcome.kind !== "confirmed") announceError(t`Couldn't stop the reply.`);
    });
  }, [operation, settle]);

  return { status, stop };
}
