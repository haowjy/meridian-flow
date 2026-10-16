/** Deadline classification protects evidence labels independently of transport timing. */
import type { ThreadSnapshotResponse } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { EXIT } from "../../core/cli-error";
import { Output, TERMINAL_KEYS } from "../../core/output";
import { snapshotOf, THREAD_ID } from "../../test-support/wire-fixtures";
import { classifyDeadline, finishResult, terminalResult } from "./result";

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

describe("classifyDeadline", () => {
  it("running takes precedence over owed and awake and offers cancellation", () => {
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
  });

  it("owed requires a pending writer message and takes precedence over awake", () => {
    const state = snapshot();
    state.liveState.status = { kind: "awake", phase: "generating", cancelRequested: false };
    state.liveState.runState.items = [message];
    expect(classifyDeadline(state, THREAD_ID)).toMatchObject({
      reason: "owed",
      stillRunning: null,
      owed: [message],
    });
  });
});

it.each([
  "thread.send",
  "thread.tail",
])("renders %s timeout without activity evidence as unconfirmed", (command) => {
  let stderr = "";
  const out = new Output(
    {
      stdout: { write: () => true },
      stderr: {
        write: (chunk) => {
          stderr += chunk;
        },
      },
    },
    { json: false },
  );
  const { reason, ...report } = classifyDeadline(null, THREAD_ID);
  const terminal = terminalResult(
    command,
    { outcome: "timeout", reason },
    { threadId: THREAD_ID, ...report },
  );
  expect(terminal.result).not.toHaveProperty("stillRunning");
  expect(terminal.result).not.toHaveProperty("owed");
  expect(finishResult(out, terminal)).toBe(EXIT.timeout);
  expect(stderr).toBe(`timeout ? unconfirmed\n./mf thread tail ${THREAD_ID} --until-idle\n`);
});

it("defines the reserved terminal keys once", () => {
  expect(TERMINAL_KEYS).toEqual(["type", "command", "outcome", "reason"]);
});

it.each(["object", "stream"] as const)("retains terminal keys in %s output", (mode) => {
  for (const fields of [["finalText"], ["absent"]]) {
    let stdout = "";
    const out = new Output(
      {
        stdout: {
          write: (chunk) => {
            stdout += chunk;
          },
        },
        stderr: { write: () => true },
      },
      { json: true, fields },
    );
    const value = {
      type: "result",
      command: "thread.send",
      outcome: "unproven",
      reason: "owed",
      finalText: "reply",
      threadId: "t1",
    };
    if (mode === "object") out.result(value, () => "");
    else out.record(value, null, "err");
    expect(JSON.parse(stdout)).toEqual({
      type: "result",
      command: "thread.send",
      outcome: "unproven",
      reason: "owed",
      ...(fields.includes("finalText") ? { finalText: "reply" } : {}),
    });
  }
});
