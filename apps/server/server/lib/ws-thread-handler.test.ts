/**
 * Purpose: Verifies thread WebSocket control-message behavior that is not covered by route tests.
 * Key decision: checkpoint.respond is validated against the process-local pending checkpoint registry, so late responses must return a structured error instead of silently disappearing.
 */

import { EventType, parseWsServerMessage } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { createInMemoryProjectRepository } from "../domains/projects/index.js";
import type { Gateway, GenerateRequest } from "../domains/runtime/index.js";
import {
  createInMemoryEventJournalReader,
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
  createThreadEventHub,
} from "../domains/threads/index.js";
import { createInMemoryAppServices } from "./compose.js";
import { createThreadWebSocketSession, type WsPeer } from "./ws-thread-handler.js";

function inertGateway(): Gateway {
  return {
    async *stream(_request: GenerateRequest) {
      yield {
        type: "error",
        code: "provider_error",
        message: "not used in this test",
        retryable: false,
      };
      throw new Error("not used in this test");
    },
    async generate(_request: GenerateRequest) {
      throw new Error("not used in this test");
    },
  };
}

function createCheckpointTestApp() {
  const app = createInMemoryAppServices();
  const journalWriter = createInMemoryEventJournalWriter();
  const journalReader = createInMemoryEventJournalReader(journalWriter);
  const hub = createThreadEventHub({ journalReader, journalWriter, eventSink: app.eventSink });
  app.gateway = inertGateway();
  app.threadRepos = createInMemoryRepositories();
  app.repos = app.threadRepos;
  app.threadRuntime = {
    async requireOwnedThread(threadId, userId) {
      const thread = await app.repos.threads.findById(threadId);
      if (!thread || thread.userId !== userId) throw new Error("Thread not found");
      return {
        ...thread,
        workId: thread.workId ?? "work-1",
        currentAgentId: thread.currentAgent,
        activeLeafTurnId: null,
        nextSeq: BigInt(thread.nextSeq ?? "0"),
      };
    },
    async liveState(threadId, userId) {
      await this.requireOwnedThread(threadId, userId);
      const turns = await app.repos.turns.listByThread(threadId);
      const waiting = turns.find((turn) => turn.status === "waiting_checkpoint");
      const headSeq = await journalReader.headSeq(threadId);
      return {
        threadId,
        status: waiting ? "error" : "idle",
        runningTurnId: null,
        currentAgent: null,
        nextSeq: (headSeq + 1n).toString(),
        resumeAfterSeq: headSeq.toString(),
      };
    },
    async sendMessage() {
      throw new Error("not used in this test");
    },
    async journalEvents() {
      return [];
    },
  };
  app.journalReader = journalReader;
  app.journalWriter = journalWriter;
  app.threadEventHub = hub;
  app.hub = hub;
  app.projectRepo = createInMemoryProjectRepository();
  return app;
}

describe("thread WebSocket checkpoint responses", () => {
  it("returns an error for late checkpoint responses with no pending registry entry", async () => {
    const app = createCheckpointTestApp();
    const project = await app.projectRepo.create({ id: "project-1", userId: "user-1" });
    const thread = await app.repos.threads.create({ userId: "user-1", projectId: project.id });
    const sent: string[] = [];
    const peer: WsPeer = {
      request: new Request("https://app.localhost/ws"),
      context: { app, userId: "user-1" },
      send: (data) => sent.push(data),
      close: () => {},
    };
    const session = createThreadWebSocketSession(peer);

    await session.onMessage(
      JSON.stringify({
        type: "checkpoint.respond",
        threadId: thread.id,
        turnId: "turn-expired",
        checkpointId: "checkpoint-expired",
        value: { value: "late" },
      }),
    );

    expect(sent.map((frame) => parseWsServerMessage(frame))).toEqual([
      {
        type: "error",
        kind: "error",
        error: {
          code: "checkpoint_not_pending",
          message: "No pending checkpoint",
          retryable: false,
          source: "system",
        },
        threadId: thread.id,
      },
    ]);
  });
});

describe("thread WebSocket checkpoint recovery", () => {
  it("surfaces checkpoint catchup and error live state on subscribe", async () => {
    const app = createCheckpointTestApp();
    const project = await app.projectRepo.create({
      id: "project-recovery",
      userId: "user-1",
    });
    const thread = await app.repos.threads.create({ userId: "user-1", projectId: project.id });
    const turn = await app.repos.turns.create({
      threadId: thread.id,
      role: "assistant",
      status: "waiting_checkpoint",
    });
    await app.hub.appendEvent(thread.id, {
      type: "checkpoint.created",
      turnId: turn.id,
      checkpointId: "checkpoint-recovery-ws",
      blockSequence: 0,
      request: {
        checkpointId: "checkpoint-recovery-ws",
        prompt: "test",
        artifacts: [],
        answerSchema: { type: "object", properties: { value: { type: "string" } } },
      },
    });

    const sent: string[] = [];
    const peer: WsPeer = {
      request: new Request("https://app.localhost/ws"),
      context: { app, userId: "user-1" },
      send: (data) => sent.push(data),
      close: () => {},
    };
    const session = createThreadWebSocketSession(peer);

    await session.onMessage(
      JSON.stringify({
        type: "subscribe",
        threadId: thread.id,
        lastSeq: "0",
      }),
    );

    const subscribed = sent
      .map((frame) => parseWsServerMessage(frame))
      .find((frame) => frame?.type === "subscribed");
    expect(subscribed).toMatchObject({
      type: "subscribed",
      threadId: thread.id,
      state: { status: "error", runningTurnId: null },
    });
    if (subscribed?.type !== "subscribed") throw new Error("missing subscribed frame");

    expect(subscribed.catchup.map((entry) => entry.event)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: EventType.CUSTOM,
          name: "meridian.checkpoint",
          value: expect.objectContaining({
            turnId: turn.id,
            checkpointId: "checkpoint-recovery-ws",
            state: "created",
            blockSequence: 0,
          }),
        }),
      ]),
    );
  });
});
