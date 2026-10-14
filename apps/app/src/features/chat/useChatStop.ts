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
 */
import { t } from "@lingui/core/macro";
import type { StopResponse } from "@meridian/contracts/threads";
import {
  composerDocFromHandedBack,
  handBackCandidates,
  stopRequest,
} from "@meridian/thread-client";
import { useCallback, useEffect, useRef } from "react";
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

export function useChatStop(input: { threadId: string; accountId: string }): () => void {
  const { threadId, accountId } = input;
  const view = useRunState(threadId);
  const actions = useThreadActions();
  const latest = useRef({ view, actions });
  latest.current = { view, actions };

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
          const written = answer.handedBack.length
            ? draft.receiveHandBack(requestId, composerDocFromHandedBack(answer.handedBack))
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
            announceError(t`Couldn't stop. Try again.`);
            return;
          }
          dispatch(threadId, {
            type: "answer",
            kind: "handBack",
            id: requestId,
            version: answer.runState.version,
          });
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
          announceError(t`Couldn't stop. Try again.`);
        },
      );
    },
    [threadId],
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
      post(draft, command);
    },
    [post, threadId],
  );

  // A reload re-posts every command the draft still holds; one already received is dropped.
  useEffect(() => {
    const draft = composerSessionDraft(accountId, { kind: "chat", id: threadId });
    for (const command of draft.handBacks) {
      if (draft.hasReceivedHandBack(command.requestId)) draft.dropHandBack(command.requestId);
      else send(draft, command);
    }
  }, [accountId, threadId, send]);

  return useCallback(() => {
    const draft = composerSessionDraft(accountId, { kind: "chat", id: threadId });
    const { view: held } = latest.current;
    // Pressing again after a lost request re-posts that request, same id and body.
    const failed = held.intents.find((intent) => intent.kind === "handBack" && intent.failed);
    const pending = failed && draft.handBacks.find((command) => command.requestId === failed.id);
    if (pending) {
      send(draft, pending);
      return;
    }
    const requestId = crypto.randomUUID();
    const command: PendingHandBack = {
      kind: "stop",
      requestId,
      body: stopRequest(held, requestId),
    };
    if (!draft.recordHandBack(command)) {
      announceError(t`Couldn't stop. Try again.`);
      return;
    }
    announce(t`Stopping`);
    send(draft, command);
  }, [accountId, send, threadId]);
}
