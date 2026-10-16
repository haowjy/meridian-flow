/**
 * useSendNow — Send now on the queue: cancel the reply the writer saw so the waiting queue runs
 * next. The body is built from the record the writer sees and posted by `postSendNow`; a lost
 * answer is re-sent with the same frozen body, never one rebuilt from a newer record. `null`
 * from the server means this attempt requested no cancellation, which is not a failure.
 *
 * The control's state reuses `stopStatus`: pending at once, stopping while the record still shows
 * the cancelled execution, idle after. A failed Send now is a card (`handBackCards`).
 */
import { t } from "@lingui/core/macro";
import type { SendNowRequest } from "@meridian/contracts/threads";
import {
  type FailedSendNow,
  postSendNow,
  type StopStatus,
  sendNowRequest,
  stopStatus,
} from "@meridian/thread-client";
import { useCallback, useRef, useState } from "react";
import { postCommand } from "@/client/api/threads-api";
import { announce, announceError, useRunState, useThreadActions } from "@/client/stores";

export type SendNow = {
  /** Whether the record shows an open reply with a queue behind it. */
  available: boolean;
  /** Pending or stopping: the button rings. */
  busy: boolean;
  send: () => void;
  failed: FailedSendNow | null;
  /** Re-send the failed body, unchanged. */
  retry: () => void;
  dismiss: () => void;
};

export function useSendNow(threadId: string): SendNow {
  const view = useRunState(threadId);
  const actions = useThreadActions();
  const latest = useRef({ view, actions });
  latest.current = { view, actions };
  const [command, setCommand] = useState<{
    request: "idle" | "pending";
    cancelledExecutionId: string | null;
  }>({ request: "idle", cancelledExecutionId: null });
  const [failed, setFailed] = useState<FailedSendNow | null>(null);
  const busyRef = useRef(false);

  const status: StopStatus = stopStatus(view, { ...command, failedStops: [] });
  const busy = status === "pending" || status === "stopping";
  busyRef.current = busy;

  const post = useCallback(
    (body: SendNowRequest) => {
      setCommand({ request: "pending", cancelledExecutionId: null });
      setFailed(null);
      void postSendNow(
        {
          http: postCommand,
          runState: {
            receive: (record) =>
              latest.current.actions.dispatchRunState(threadId, {
                type: "snapshot",
                runState: record,
              }),
          },
        },
        threadId,
        body,
      ).then((outcome) => {
        setCommand({
          request: "idle",
          cancelledExecutionId: outcome.kind === "confirmed" ? outcome.cancelledExecutionId : null,
        });
        if (outcome.kind === "confirmed") return;
        setFailed({
          kind: "send-now",
          status: outcome.kind,
          request: body,
        });
        announceError(t`Couldn't send now.`);
      });
    },
    [threadId],
  );

  const send = useCallback(() => {
    if (busyRef.current) return;
    const body = sendNowRequest(latest.current.view);
    if (!body) return;
    announce(t`Sending now`);
    post(body);
  }, [post]);
  const retry = useCallback(() => {
    if (failed && !busyRef.current) post(failed.request);
  }, [failed, post]);
  const dismiss = useCallback(() => setFailed(null), []);

  return { available: sendNowRequest(view) !== null, busy, send, failed, retry, dismiss };
}
