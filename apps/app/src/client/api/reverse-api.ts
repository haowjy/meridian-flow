import {
  apiThreadContextReversePath,
  type ReversalOutcome,
  type WorkReversalResult,
} from "@meridian/contracts/protocol";

import { httpErrorStatus, postJson } from "./http-client";

const LOST_REQUEST_ATTEMPTS = 3;

export type ReverseTurnInput = {
  turnId: string;
};

export async function reverseTurn(
  threadId: string,
  input: ReverseTurnInput,
): Promise<ReversalOutcome> {
  const body = {
    commandId: crypto.randomUUID(),
    scope: "turn",
    target: input.turnId,
  };
  for (let attempt = 1; ; attempt++) {
    try {
      return await postJson<ReversalOutcome>(apiThreadContextReversePath(threadId), body);
    } catch (cause) {
      if (httpErrorStatus(cause) !== undefined || attempt >= LOST_REQUEST_ATTEMPTS) throw cause;
    }
  }
}

export function successfulWorkReversals(outcome: ReversalOutcome): WorkReversalResult[] {
  return (outcome.workReceipts ?? []).filter((result) => result.status === "reversed");
}
