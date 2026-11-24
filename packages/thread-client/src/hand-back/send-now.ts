import { apiThreadSendNowPath, sendNowResponseSchema } from "@meridian/contracts/protocol";
import type { RunState, SendNowRequest } from "@meridian/contracts/threads";
import { classifyAnswer, type FrozenRequest, type HttpPort, postFrozen } from "./classify";

export type FailedSendNow = {
  kind: "send-now";
  status: "ambiguous" | "refused";
  request: SendNowRequest;
  attempt: number;
  requestId: string;
};

export type SendNowOutcome =
  | { kind: "confirmed"; cancelledExecutionId: string | null; runState: RunState }
  | { kind: "refused"; status: number }
  | { kind: "ambiguous"; request: FrozenRequest };

export type SendNowPorts = {
  http: HttpPort;
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
