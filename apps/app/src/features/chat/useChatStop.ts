/**
 * useChatStop — the composer's Stop: cancel the running reply and take every waiting writer
 * message back into this tab's composer.
 *
 * The lifecycle is the hand-back one (`packages/thread-client/src/run-state/fold-messages.ts`
 * and `message/hand-back.ts` own its rules; this file only wires them):
 *
 * - The press mints a request id and writes the whole command to this tab's composer draft
 *   (`handBacks`) before anything is sent, so a reload can't lose a press. If that write fails,
 *   nothing is sent and the control says so.
 * - It then adds the hand-back intent (which hides the messages it covers at once) and posts.
 * - The answer's record goes into the run-state slice, the turns it handed back or found gone
 *   leave the transcript store at the record's version, and one checked draft write prepends the
 *   content above what is typed, records its receipt and retires the command. Only then is the
 *   intent answered.
 * - A lost request keeps the command and marks the intent failed (the messages show again);
 *   pressing Stop again re-posts the same id and body. A refusal drops both.
 * - A reload re-posts every command still in the draft; one whose receipt is recorded is dropped.
 *
 * The hook also owns the Stop control's state (`StopStatus`), which only this tab has: other tabs
 * see the record, never Stopping. The press is `pending` (Stopping at once). On the answer, an
 * answer that names a cancelled execution is `stopping` while the held record still shows that
 * execution; any other answer clears with the answer. A failed request is `failed`, which stays
 * until the next press, even after the chat goes idle, so the retry stays reachable.
 */
import { t } from "@lingui/core/macro";
import type { StopResponse } from "@meridian/contracts/threads";
import {
  type ChatReferenceScope,
  chatReferenceResolver,
  composerDocFromHandedBack,
  handBackCandidates,
  type StopStatus,
  stopRequest,
  stopStatus,
} from "@meridian/thread-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { httpErrorStatus } from "@/client/api/http-client";
import { stopThread } from "@/client/api/threads-api";
import {
  type ComposerSessionDraft,
  composerSessionDraft,
  type PendingHandBack,
} from "@/client/composer-drafts";
import { announce, announceError, useRunState, useThreadActions } from "@/client/stores";

/** The server decided against the request: nothing came back, and re-sending would be refused again. */
function isRefusal(error: unknown): boolean {
  const status = httpErrorStatus(error);
  return status !== undefined && status >= 400 && status < 500;
}

export type ChatStop = {
  status: StopStatus;
  /** Press Stop. While pending or stopping it does nothing; after a failure it re-posts. */
  stop: () => void;
};

type StopCommandState = {
  request: "idle" | "pending" | "failed";
  cancelledExecutionId: string | null;
};

export function useChatStop(input: {
  threadId: string;
  accountId: string;
  /** Where the chat's handed-back references live; null until the chat has loaded. */
  scope: ChatReferenceScope | null;
}): ChatStop {
  const { threadId, accountId, scope } = input;
  const view = useRunState(threadId);
  const actions = useThreadActions();
  const latest = useRef({ view, actions, scope });
  latest.current = { view, actions, scope };
  const [command, setCommand] = useState<StopCommandState>({
    request: "idle",
    cancelledExecutionId: null,
  });
  const requestIs = useCallback(
    (request: StopCommandState["request"], cancelledExecutionId: string | null = null) =>
      setCommand({ request, cancelledExecutionId }),
    [],
  );

  const post = useCallback(
    (draft: ComposerSessionDraft, command: PendingHandBack) => {
      const { requestId } = command;
      const dispatch = latest.current.actions.dispatchRunState;
      stopThread(threadId, command.body).then(
        (answer: StopResponse) => {
          const { actions: store } = latest.current;
          store.dispatchRunState(threadId, { type: "snapshot", runState: answer.runState });
          // Handed back or found already gone: both left the conversation at this record.
          const left = [...answer.handedBack.map((message) => message.userTurnId), ...answer.gone];
          if (left.length) store.removeTurns(threadId, left, answer.runState.version);
          const { scope: where } = latest.current;
          const written = answer.handedBack.length
            ? draft.receiveHandBack(
                requestId,
                // Without the chat's facts a reference comes back as its link text.
                composerDocFromHandedBack(
                  answer.handedBack,
                  where ? chatReferenceResolver(where) : () => null,
                ),
              )
            : draft.dropHandBack(requestId);
          if (!written) {
            // The content is still on the server's side of the line, and the command is kept: the
            // next press re-posts the same request and brings it again.
            dispatch(threadId, {
              type: "intent",
              intent: {
                kind: "handBack",
                id: requestId,
                candidates: [],
                failed: true,
                answer: null,
              },
            });
            requestIs("failed");
            announceError(t`Couldn't stop. Try again.`);
            return;
          }
          dispatch(threadId, {
            type: "answer",
            kind: "handBack",
            id: requestId,
            version: answer.runState.version,
          });
          requestIs("idle", answer.cancelledExecutionId);
        },
        (error: unknown) => {
          if (isRefusal(error)) {
            draft.dropHandBack(requestId);
            dispatch(threadId, { type: "drop", kind: "handBack", id: requestId });
          } else {
            // The server may have acted: the rows show again, still queued, until a frame or the
            // re-posted request says otherwise.
            const known = latest.current.view.intents.find(
              (intent) => intent.kind === "handBack" && intent.id === requestId,
            );
            dispatch(threadId, {
              type: "intent",
              intent: {
                kind: "handBack",
                id: requestId,
                candidates: known?.kind === "handBack" ? known.candidates : [],
                failed: true,
                answer: null,
              },
            });
          }
          requestIs("failed");
          announceError(t`Couldn't stop. Try again.`);
        },
      );
    },
    [requestIs, threadId],
  );

  /** Hide the covered messages and send: the intent first, so the rows leave at once. */
  const send = useCallback(
    (draft: ComposerSessionDraft, command: PendingHandBack) => {
      const { view: held, actions: store } = latest.current;
      const known = held.intents.find(
        (intent) => intent.kind === "handBack" && intent.id === command.requestId,
      );
      store.dispatchRunState(threadId, {
        type: "intent",
        intent: {
          kind: "handBack",
          id: command.requestId,
          candidates:
            known?.kind === "handBack"
              ? known.candidates
              : handBackCandidates(held, {
                  kind: "seen",
                  seenThrough: command.body.seenThrough,
                  mine: command.body.mine,
                }),
          failed: false,
          answer: null,
        },
      });
      requestIs("pending");
      post(draft, command);
    },
    [post, requestIs, threadId],
  );

  // A reload re-posts every command the draft still holds; one already received is dropped.
  useEffect(() => {
    const draft = composerSessionDraft(accountId, { kind: "chat", id: threadId });
    for (const command of draft.handBacks) {
      if (draft.hasReceivedHandBack(command.requestId)) draft.dropHandBack(command.requestId);
      else send(draft, command);
    }
  }, [accountId, threadId, send]);

  const stop = useCallback(() => {
    const draft = composerSessionDraft(accountId, { kind: "chat", id: threadId });
    const { view: held } = latest.current;
    // Pressing again after a lost request re-posts the stored one, same id and body.
    const pending = draft.handBacks.find((stored) => stored.kind === "stop");
    if (pending) {
      send(draft, pending);
      return;
    }
    const requestId = crypto.randomUUID();
    const next: PendingHandBack = {
      kind: "stop",
      requestId,
      body: stopRequest(held, requestId),
    };
    if (!draft.recordHandBack(next)) {
      requestIs("failed");
      announceError(t`Couldn't stop. Try again.`);
      return;
    }
    announce(t`Stopping`);
    send(draft, next);
  }, [accountId, requestIs, send, threadId]);

  const status = stopStatus(view, command);
  const pressed = useRef(status);
  pressed.current = status;
  return {
    status,
    // Ignored while Stopping: the request is out, or the cancel is landing.
    stop: useCallback(() => {
      if (pressed.current === "pending" || pressed.current === "stopping") return;
      stop();
    }, [stop]),
  };
}
