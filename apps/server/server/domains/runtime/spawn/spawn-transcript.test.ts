/** Return-result capture and tool settlement share one repository transaction. */
import type { ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createInMemoryProjectRepository } from "../../projects/index.js";
import {
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
} from "../../threads/index.js";
import { finalizeExecution } from "../loop/execution-finalizer.js";
import { persistReturnResult, type SpawnTranscript } from "./spawn-transcript.js";

async function setup() {
  const projects = createInMemoryProjectRepository();
  const repos = createInMemoryRepositories({ projects });
  const project = await projects.create({ userId: "writer", title: "Return" });
  const parent = await repos.threads.create({ userId: "writer", projectId: project.id });
  const child = await repos.threads.createSubagent({
    userId: "writer",
    projectId: project.id,
    parentThreadId: parent.id,
    rootThreadId: parent.id,
    spawnDepth: 1,
  });
  const turn = await repos.turns.create({
    threadId: child.id,
    role: "assistant",
    status: "streaming",
    prevTurnId: null,
  });
  await repos.executionReports.admit({
    childThreadId: child.id,
    assistantTurnId: turn.id,
    handle: child.ref ?? "",
    origin: "thread_run",
    deliveryMode: "none",
    callerThreadId: null,
    callerTurnId: null,
    toolCallId: null,
    cardBlockId: null,
  });
  const transcript: SpawnTranscript = {
    persistence: { repos, eventWriter: createInMemoryEventJournalWriter() },
    threadId: child.id as ThreadId,
    turnId: turn.id,
    blockSeqRef: { value: 0 },
    allBlocks: [],
    events: [],
  };
  return { repos, child, turn, transcript };
}

describe("persistReturnResult", () => {
  it("settles the candidate and successful tool result together without a premature report card", async () => {
    const { repos, child, turn, transcript } = await setup();
    const settled = await persistReturnResult(transcript, {
      toolCallId: "return-1",
      outcome: { ok: true },
      capture: { summary: "done", payload: { answer: 42 } },
      executionReports: repos.executionReports,
    });

    expect(settled.endTurn).toBe(true);
    expect(transcript.allBlocks.map((block) => block.blockType)).toEqual(["tool_result"]);
    expect(settled.block.content).toMatchObject({ output: { ok: true }, isError: false });
    expect(await repos.executionReports.findByExecution(child.id, turn.id)).toMatchObject({
      capture: { summary: "done", payload: { answer: 42 } },
      captureToolCallId: "return-1",
      outcome: null,
    });
  });

  it("persists a rejected competing return as a failed ordinary tool result", async () => {
    const { repos, child, turn, transcript } = await setup();
    await repos.executionReports.captureOnce(child.id, turn.id, "first", { summary: "kept" });
    const settled = await persistReturnResult(transcript, {
      toolCallId: "second",
      outcome: { ok: true },
      capture: { summary: "discarded" },
      executionReports: repos.executionReports,
    });

    expect(settled.endTurn).toBe(false);
    expect(settled.block.content).toMatchObject({ output: { ok: false }, isError: true });
    expect(await repos.executionReports.findByExecution(child.id, turn.id)).toMatchObject({
      capture: { summary: "kept" },
      captureToolCallId: "first",
    });
  });

  it("rolls the candidate back when tool-result publication fails", async () => {
    const { repos, child, turn, transcript } = await setup();
    transcript.persistence.eventWriter = {
      async appendEvent() {
        throw new Error("journal failed");
      },
    };
    await expect(
      persistReturnResult(transcript, {
        toolCallId: "return-1",
        outcome: { ok: true },
        capture: { summary: "candidate" },
        executionReports: repos.executionReports,
      }),
    ).rejects.toThrow("journal failed");
    expect(await repos.executionReports.findByExecution(child.id, turn.id)).toMatchObject({
      capture: null,
      outcome: null,
    });
    expect(await repos.blocks.listByTurn(turn.id)).toEqual([]);
  });
});

describe("captured candidate terminal policy", () => {
  it("does not convert captured content into success after a failed run", async () => {
    const { repos, child, turn, transcript } = await setup();
    await persistReturnResult(transcript, {
      toolCallId: "return-1",
      outcome: { ok: true },
      capture: { summary: "partial candidate", payload: { retained: true } },
      executionReports: repos.executionReports,
    });
    await finalizeExecution(
      { repos, eventWriter: transcript.persistence.eventWriter },
      {
        threadId: child.id,
        assistantTurnId: turn.id,
        cause: { kind: "failed", reason: "runtime_error", error: "later failure" },
      },
    );
    expect(await repos.executionReports.findByExecution(child.id, turn.id)).toMatchObject({
      outcome: "failed",
      source: "return_result",
      summary: "partial candidate",
      payload: { retained: true },
    });
  });

  it("rolls terminal status and report back together when the journal fails", async () => {
    const { repos, child, turn, transcript } = await setup();
    await expect(
      finalizeExecution(
        {
          repos,
          eventWriter: {
            async appendEvent() {
              throw new Error("journal failed");
            },
          },
        },
        {
          threadId: child.id,
          assistantTurnId: turn.id,
          cause: { kind: "success", finishReason: "end_turn", finalPublicText: "result" },
        },
      ),
    ).rejects.toThrow("journal failed");
    expect((await repos.turns.findById(turn.id))?.status).toBe("streaming");
    expect(await repos.executionReports.findByExecution(child.id, turn.id)).toMatchObject({
      outcome: null,
    });
    await finalizeExecution(
      { repos, eventWriter: transcript.persistence.eventWriter },
      {
        threadId: child.id,
        assistantTurnId: turn.id,
        cause: { kind: "success", finishReason: "end_turn", finalPublicText: "result" },
      },
    );
    expect(await repos.executionReports.findByExecution(child.id, turn.id)).toMatchObject({
      outcome: "succeeded",
      summary: "result",
    });
  });
});
