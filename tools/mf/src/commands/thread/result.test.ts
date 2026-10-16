/** Deadline classification protects evidence labels independently of transport timing. */
import type { ThreadSnapshotResponse } from "@meridian/contracts/protocol";
import { expect, it } from "vitest";
import { EXIT } from "../../core/cli-error";
import { snapshotOf, THREAD_ID } from "../../test-support/wire-fixtures";
import { classifyDeadline, terminalResult } from "./result";

const snapshot = () => snapshotOf();
const message: ThreadSnapshotResponse["liveState"]["runState"]["items"][number] = {
  id: "writer-message",
  seq: 1,
  intent: "message",
  provenance: { kind: "writer", actorId: "u1" },
  deliveryState: "waiting",
  summary: "Continue",
  enqueuedAt: "2026-01-01T00:00:00.000Z",
};

it("classifies a deadline by what the last read can and cannot say: running, then owed, then an awake lease, then unconfirmed", () => {
  const state = snapshot();
  state.liveState.runState.execution = { executionId: "e1", currentTurnId: "running-turn" };
  state.liveState.status = { kind: "awake", phase: "generating", cancelRequested: false };
  state.liveState.runState.items = [message];
  expect(classifyDeadline(state, THREAD_ID)).toEqual({
    reason: "running",
    stillRunning: { turnId: "running-turn", status: "unknown" },
    owed: [message],
    next: [`./mf thread stop ${THREAD_ID}`, `./mf thread tail ${THREAD_ID} --until-idle`],
  });

  state.liveState.runState.execution = null;
  expect(classifyDeadline(state, THREAD_ID)).toMatchObject({
    reason: "owed",
    stillRunning: null,
    owed: [message],
  });

  state.liveState.runState.items = [];
  expect(classifyDeadline(state, THREAD_ID)).toEqual({
    reason: "lease_awake",
    stillRunning: null,
    owed: [],
    next: [`./mf thread tail ${THREAD_ID} --until-idle`],
  });

  // Asleep with nothing owed, or no read at all: never a success claim.
  state.liveState.status = { kind: "asleep" };
  const idle = classifyDeadline(state, THREAD_ID);
  expect(idle).toEqual({
    reason: "unconfirmed",
    stillRunning: null,
    owed: [],
    next: [`./mf thread tail ${THREAD_ID} --until-idle`],
  });
  const unavailable = classifyDeadline(null, THREAD_ID);
  expect(unavailable).toEqual({
    reason: "unconfirmed",
    next: [`./mf thread tail ${THREAD_ID} --until-idle`],
  });
  expect(unavailable).not.toHaveProperty("stillRunning");
  expect(unavailable).not.toHaveProperty("owed");
  expect(
    terminalResult(
      "thread.tail",
      { outcome: "timeout", reason: unavailable.reason },
      { threadId: THREAD_ID, ...unavailable },
    ).exitCode,
  ).toBe(EXIT.timeout);
});
