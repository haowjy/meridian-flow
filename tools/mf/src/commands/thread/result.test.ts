/** Deadline classification protects evidence labels independently of transport timing. */
import type { ThreadSnapshotResponse } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { EXIT } from "../../core/cli-error";
import { Output } from "../../core/output";
import { PROJECT_ID, THREAD_ID } from "../../test-support/fake-stack";
import { classifyDeadline, finishResult, terminalResult } from "./result";

const snapshot = (): ThreadSnapshotResponse => ({
  threadId: THREAD_ID,
  thread: {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    workId: null,
    aiWriteMode: "direct",
    effectiveAiWriteMode: "direct",
    userId: "u1",
    kind: "primary",
    status: "idle",
    title: "Fake thread",
    ref: "c1",
    initialPromptBakeId: null,
    agentDefinitionRevisionId: null,
    agentName: "General",
    activeLeafTurnId: null,
    parentThreadId: null,
    rootThreadId: THREAD_ID,
    spawnDepth: 0,
    spawnStatus: null,
    totalCostUsd: "0",
    turnCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    lastActivityAt: "2026-01-02T00:00:00.000Z",
    deletedAt: null,
  },
  turns: [],
  threadUsage: {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheReportedInputTokens: 0,
    cacheReportedCalls: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    cacheResets: 0,
  },
  liveState: {
    threadId: THREAD_ID,
    status: { kind: "asleep" },
    activity: { children: [] },
    runState: {
      version: "0",
      items: [],
      sentThrough: 0,
      execution: null,
      mode: "direct",
      blocked: null,
    },
    resumeAfterSeq: "0",
  },
  actionRequired: false,
  nextSeq: "1",
  ancestors: [],
});
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
      next: [
        `./mf thread cancel ${THREAD_ID} --turn running-turn`,
        `./mf thread tail ${THREAD_ID} --until-idle`,
      ],
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

  it("lease_awake describes an awake lease with no running turn or writer message", () => {
    const state = snapshot();
    state.liveState.status = { kind: "awake", phase: "generating", cancelRequested: false };
    expect(classifyDeadline(state, THREAD_ID)).toEqual({
      reason: "lease_awake",
      stillRunning: null,
      owed: [],
      next: [`./mf thread tail ${THREAD_ID} --until-idle`],
    });
  });

  it.each([
    "unavailable",
    "idle",
  ] as const)("unconfirmed describes %s evidence without claiming success", (evidence) => {
    const report = classifyDeadline(evidence === "idle" ? snapshot() : null, THREAD_ID);
    expect(report).toEqual({
      reason: "unconfirmed",
      ...(evidence === "idle" ? { stillRunning: null, owed: [] } : {}),
      next: [`./mf thread tail ${THREAD_ID} --until-idle`],
    });
    if (evidence === "unavailable") {
      expect(report).not.toHaveProperty("stillRunning");
      expect(report).not.toHaveProperty("owed");
    }
    expect(
      terminalResult(
        "thread.tail",
        { outcome: "timeout", reason: report.reason },
        {
          threadId: THREAD_ID,
          ...report,
        },
      ).exitCode,
    ).toBe(EXIT.timeout);
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
