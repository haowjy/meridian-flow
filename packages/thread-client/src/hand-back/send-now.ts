/**
 * Send now: cancel the reply the writer saw so the waiting queue runs next. It is not a
 * hand-back command (nothing comes back, nothing is persisted, no intent hides rows), so it
 * shares only the classifier. A lost answer is re-sent with the same frozen body.
 */
import { apiThreadSendNowPath, sendNowResponseSchema } from "@meridian/contracts/protocol";
import type { RunState, SendNowRequest } from "@meridian/contracts/threads";
import { classifyAnswer, type FrozenRequest, type HttpPort, postFrozen } from "./classify";

/** A Send now that did not succeed. The host holds it; it is not a hand-back command. */
export type FailedSendNow = {
  kind: "send-now";
  status: "ambiguous" | "refused";
  /** The frozen body, re-sent unchanged by Try again. */
  request: SendNowRequest;
  /** How many times this body has been posted: the card's occurrence, after its execution. */
  attempt: number;
  requestId: string;
};

export type SendNowOutcome =
  /** `cancelledExecutionId: null` means this attempt requested no cancellation, nothing about the reply's fate. */
  | { kind: "confirmed"; cancelledExecutionId: string | null; runState: RunState }
  | { kind: "refused"; status: number }
  | { kind: "ambiguous"; request: FrozenRequest };

export type SendNowPorts = {
  http: HttpPort;
  /** The same run-state port the hand-back operation uses; only `receive` is needed. */
  runState: { receive(record: RunState): void };
};

export async function postSendNow(
  ports: SendNowPorts,
  threadId: string,
  body: SendNowRequest,
): Promise<SendNowOutcome> {
  const request: FrozenRequest = { path: apiThreadSendNowPath(threadId), body };
  const verdict = classifyAnswer(await postFrozen(ports.http, request), sendNowResponseSchema);
  if (verdict.kind === "refused") return verdict;
  if (verdict.kind === "ambiguous") return { kind: "ambiguous", request };
  ports.runState.receive(verdict.answer.runState);
  return {
    kind: "confirmed",
    cancelledExecutionId: verdict.answer.cancelledExecutionId,
    runState: verdict.answer.runState,
  };
}
