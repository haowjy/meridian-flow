import { t } from "@lingui/core/macro";
import type { FailureEnd } from "@meridian/contracts/failures";
import type { SendNowRequest } from "@meridian/contracts/threads";
import {
  type CommandFailure,
  type FailedSendNow,
  logCommandFailure,
  postSendNow,
  type StopStatus,
  sendNowRequest,
  stopStatus,
} from "@meridian/thread-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { postCommand } from "@/client/api/threads-api";
import { useFailureLog } from "@/client/failures/failure-log";
import { announce, useRunState, useThreadActions, useThreadAsks } from "@/client/stores";

export type SendNow = {
  available: boolean;
  busy: boolean;
  send: () => void;
  failed: FailedSendNow | null;
  retry: () => void;
  dismiss: () => void;
};

export function useSendNow(threadId: string): SendNow {
  const view = useRunState(threadId);
  const asks = useThreadAsks(threadId);
  const log = useFailureLog();
  const actions = useThreadActions();
  const latest = useRef({ view, asks, actions });
  latest.current = { view, asks, actions };
  const [command, setCommand] = useState<{
    request: "idle" | "pending";
    cancelledExecutionId: string | null;
  }>({ request: "idle", cancelledExecutionId: null });
  const [failed, setFailed] = useState<FailedSendNow | null>(null);
  const failedRef = useRef(failed);
  const mounted = useRef(false);
  const retire = useCallback(
    (end: FailureEnd) => {
      const f = failedRef.current;
      if (f)
        logCommandFailure(
          log,
          {
            requestId: f.requestId,
            attempt: f.attempt,
            kind: f.status === "refused" ? "refused" : "lost",
          },
          { threadId },
          end,
        );
      failedRef.current = null;
      if (mounted.current) setFailed(null);
    },
    [log, threadId],
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      retire("moot");
    };
  }, [retire]);
  useEffect(() => {
    if (
      failedRef.current &&
      view.record?.execution?.executionId !== failedRef.current.request.seenExecutionId
    )
      retire("moot");
  }, [view, retire]);
  const busyRef = useRef(false);
  const attempts = useRef({ key: "", count: 0 });

  const status: StopStatus = stopStatus(view, { ...command, failedStops: [] });
  const busy = status === "pending" || status === "stopping";
  busyRef.current = busy;

  const post = useCallback(
    (body: SendNowRequest) => {
      setCommand({ request: "pending", cancelledExecutionId: null });
      retire("retried");
      const key = body.seenExecutionId;
      attempts.current = {
        key,
        count: attempts.current.key === key ? attempts.current.count + 1 : 1,
      };
      const attempt = attempts.current.count;
      const requestId = crypto.randomUUID();
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
        const failure: CommandFailure = {
          requestId,
          attempt,
          kind: outcome.kind === "refused" ? "refused" : "lost",
        };
        logCommandFailure(log, failure, { threadId });
        if (
          !mounted.current ||
          latest.current.view.record?.execution?.executionId !== body.seenExecutionId
        ) {
          logCommandFailure(log, failure, { threadId }, "moot");
          return;
        }
        const next: FailedSendNow = {
          kind: "send-now",
          status: outcome.kind,
          request: body,
          attempt,
          requestId,
        };
        failedRef.current = next;
        setFailed(next);
      });
    },
    [threadId, log, retire],
  );

  const send = useCallback(() => {
    if (busyRef.current) return;
    const body = sendNowRequest(latest.current.view, latest.current.asks.byId.values());
    if (!body) return;
    announce(t`Sending now`);
    post(body);
  }, [post]);
  const retry = useCallback(() => {
    if (failed && !busyRef.current) post(failed.request);
  }, [failed, post]);
  const dismiss = useCallback(() => retire("dismissed"), [retire]);

  return {
    available: sendNowRequest(view, asks.byId.values()) !== null,
    busy,
    send,
    failed,
    retry,
    dismiss,
  };
}
