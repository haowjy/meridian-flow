/** Loop-level inbox drain: batch delivery, request-only rendering, and the final-claim continuation. */

import type { ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createInMemoryCreditLedger } from "../../../billing/index.js";
import { createInMemoryProjectRepository } from "../../../projects/index.js";
import { createInMemoryRepositories } from "../../../threads/index.js";
import {
  createInMemoryInbox,
  createInMemoryRunAuthority,
  createInMemoryThreadLock,
} from "../../adapters/in-memory/loop-ports.js";
import type {
  Gateway,
  GenerateRequest,
  GenerateResult,
  Message,
  StreamEvent,
} from "../../gateway/index.js";
import { createOrchestrator } from "../orchestrator.js";
import type { MessageDraft } from "../ports.js";
import { NoPendingWakeError } from "../run-turn-port.js";
import { gatewayStubDefaults } from "./test-gateway.js";
import { createTestOrchestratorDeps } from "./test-orchestrator-deps.js";

const USER_ID = "user-1";

function textResult(text = "done"): GenerateResult {
  return {
    content: [{ type: "text", text }],
    toolCalls: [],
    finishReason: "end_turn",
    usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    model: "gpt-4.1-mini",
    provider: "openai",
  };
}

function toolCallResult(toolName: string, toolCallId: string): GenerateResult {
  return {
    content: [{ type: "tool_use", toolCallId, toolName, input: {} }],
    toolCalls: [],
    finishReason: "tool_use",
    usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    model: "gpt-4.1-mini",
    provider: "openai",
  };
}

function steer(key: string, threadId: ThreadId): MessageDraft {
  return {
    threadId,
    intent: "steer",
    provenance: { kind: "writer", actorId: USER_ID },
    body: { kind: "text", text: key },
    idempotencyKey: key,
  };
}

function systemMessage(key: string, threadId: ThreadId): MessageDraft {
  return {
    threadId,
    intent: "system",
    provenance: { kind: "system", source: "work" },
    body: { kind: "context", parts: [{ source: "work", text: key }] },
    idempotencyKey: key,
  };
}

function messageTexts(messages: readonly Message[]): string[] {
  return messages.flatMap((message) =>
    message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
  );
}

function messageText(message: Message): string {
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function steerTurns(turns: readonly { role: string; metadata?: unknown }[]) {
  return turns.filter(
    (turn) => turn.role === "user" && (turn.metadata as { kind?: string } | null)?.kind === "steer",
  );
}

async function setup(
  options: {
    onStream?: (call: number) => Promise<void>;
    results?: GenerateResult[];
    errorAtCall?: number;
  } = {},
) {
  const projectRepo = createInMemoryProjectRepository();
  const repos = createInMemoryRepositories({ projects: projectRepo });
  const project = await projectRepo.create({ userId: USER_ID, title: "Inbox" });
  const thread = await repos.threads.create({ userId: USER_ID, projectId: project.id });
  const creditLedger = createInMemoryCreditLedger();
  await creditLedger.grant({
    userId: USER_ID,
    source: "manual",
    amountMillicredits: "1000000",
    reason: "inbox drain test",
  });
  const inbox = createInMemoryInbox();
  const requests: GenerateRequest[] = [];
  let call = 0;
  const gateway: Gateway = {
    ...gatewayStubDefaults,
    async *stream(request: GenerateRequest): AsyncGenerator<StreamEvent> {
      call += 1;
      requests.push(request);
      await options.onStream?.(call);
      if (options.errorAtCall === call) {
        yield {
          type: "error",
          code: "provider_error",
          message: "provider failed",
          retryable: false,
        };
        return;
      }
      yield { type: "end", result: options.results?.[call - 1] ?? textResult() };
    },
    async generate() {
      throw new Error("not used");
    },
  };
  const orchestrator = createOrchestrator(
    createTestOrchestratorDeps({
      boundThreads: () => [thread.id],
      gateway,
      repos,
      creditLedger,
      inbox,
      threadLock: createInMemoryThreadLock(),
      runAuthority: createInMemoryRunAuthority(),
    }),
  );
  return { thread, inbox, requests, orchestrator, repos };
}

async function collect(handle: { events: AsyncIterable<unknown> }): Promise<void> {
  for await (const _event of handle.events) {
    // drain
  }
}

async function collectEvents(handle: {
  events: AsyncIterable<{ type: string }>;
}): Promise<Array<{ type: string }>> {
  const events: Array<{ type: string }> = [];
  for await (const event of handle.events) {
    events.push(event);
  }
  return events;
}

describe("inbox drain", () => {
  it("delivers a claimed batch in one request and acks it with the persisted turn", async () => {
    const { thread, inbox, requests, orchestrator } = await setup();
    await inbox.enqueue(steer("first steer", thread.id));
    await inbox.enqueue(steer("second steer", thread.id));

    await collect(await orchestrator.runTurn({ threadId: thread.id, userText: "hello" }));

    expect(requests).toHaveLength(1);
    const texts = messageTexts(requests[0].messages);
    expect(texts).toContain("first steer");
    expect(texts).toContain("second steer");
    expect(await inbox.claimPending(thread.id)).toEqual([]);
  });

  it("renders a system message as a request-only notice without persisting a turn", async () => {
    const { thread, inbox, requests, orchestrator, repos } = await setup();
    await inbox.enqueue(systemMessage("work context note", thread.id));

    await collect(await orchestrator.runTurn({ threadId: thread.id, userText: "hello" }));

    const texts = messageTexts(requests[0].messages);
    expect(texts.some((text) => text.includes("work context note"))).toBe(true);
    // The run's own user + assistant turns are the only persisted turns.
    expect(await repos.turns.listByThread(thread.id)).toHaveLength(2);
    expect(await inbox.claimPending(thread.id)).toEqual([]);
  });

  it("keeps the run alive when a message lands in the final-claim window", async () => {
    const { thread, inbox, requests, orchestrator } = await setup({
      onStream: async (call) => {
        if (call === 1) await inbox.enqueue(steer("late steer", thread.id));
      },
    });

    await collect(await orchestrator.runTurn({ threadId: thread.id, userText: "hello" }));

    expect(requests).toHaveLength(2);
    expect(messageTexts(requests[1].messages)).toContain("late steer");
    expect(await inbox.claimPending(thread.id)).toEqual([]);
  });

  it("persists a drained steer as a user turn the next iteration still sees", async () => {
    const { thread, inbox, requests, orchestrator, repos } = await setup({
      results: [toolCallResult("ask_user", "call-1"), textResult("done")],
    });
    await inbox.enqueue(steer("carry me", thread.id));

    await collect(await orchestrator.runTurn({ threadId: thread.id, userText: "hello" }));

    expect(requests).toHaveLength(2);
    expect(messageTexts(requests[0].messages)).toContain("carry me");
    // The steer was acked at the end of iteration 1; iteration 2 only sees it
    // because it persisted as a user-role turn, not as a request-only render.
    expect(messageTexts(requests[1].messages)).toContain("carry me");

    const turns = await repos.turns.listByThread(thread.id);
    const steerTurn = turns.find(
      (turn) =>
        turn.role === "user" && (turn.metadata as { kind?: string } | null)?.kind === "steer",
    );
    expect(steerTurn).toBeDefined();
    const blocks = await repos.blocks.listByTurn(steerTurn?.id as string);
    expect(blocks.some((block) => block.textContent === "carry me")).toBe(true);
    expect(await inbox.claimPending(thread.id)).toEqual([]);
  });

  it("redelivers an unacked steer once, without a second turn or render", async () => {
    const { thread, inbox, requests, orchestrator, repos } = await setup({ errorAtCall: 1 });
    await inbox.enqueue(steer("crash safe", thread.id));

    // First run drains and persists the steer, then fails before the response
    // acks it, so the message stays pending for the next run.
    await collect(await orchestrator.runTurn({ threadId: thread.id, userText: "first" }));
    expect(await inbox.claimPending(thread.id)).toHaveLength(1);
    let turns = await repos.turns.listByThread(thread.id);
    expect(steerTurns(turns)).toHaveLength(1);

    // Second run re-claims the same steer; the known-turn filter suppresses a
    // re-render and a re-append, and the successful response acks it.
    await collect(await orchestrator.runTurn({ threadId: thread.id, userText: "second" }));

    turns = await repos.turns.listByThread(thread.id);
    expect(steerTurns(turns)).toHaveLength(1);
    const secondRequest = requests[1];
    expect(secondRequest).toBeDefined();
    const renderCount = messageTexts(secondRequest?.messages ?? []).filter(
      (text) => text === "crash safe",
    ).length;
    expect(renderCount).toBe(1);
    expect(await inbox.claimPending(thread.id)).toEqual([]);
  });

  it("persists a steer on a second run of an already-baked thread", async () => {
    const { thread, inbox, orchestrator, repos } = await setup();

    // First run freezes the prompt (`bakedSkillSlugs` becomes non-null), so the
    // second run's assembly reuses the stale thread loaded at run start instead
    // of refreshing it from the bake.
    await collect(await orchestrator.runTurn({ threadId: thread.id, userText: "first" }));
    expect((await repos.threads.findById(thread.id))?.bakedSkillSlugs).not.toBeNull();

    await inbox.enqueue(steer("baked steer", thread.id));

    const events = await collectEvents(
      await orchestrator.runTurn({ threadId: thread.id, userText: "second" }),
    );

    expect(events.some((event) => event.type === "turn.error")).toBe(false);
    const turns = await repos.turns.listByThread(thread.id);
    expect(steerTurns(turns)).toHaveLength(1);
    expect(await inbox.claimPending(thread.id)).toEqual([]);
  });

  it("attaches a pre-turn notice to the writer message, not a drained steer", async () => {
    const { thread, inbox, requests, orchestrator } = await setup();
    await inbox.enqueue(systemMessage("work context note", thread.id));
    await inbox.enqueue(steer("steer body", thread.id));

    await collect(await orchestrator.runTurn({ threadId: thread.id, userText: "hello" }));

    const messages = requests[0]?.messages ?? [];
    const writer = messages.find(
      (message) => message.role === "user" && messageText(message).includes("hello"),
    );
    const steerMessage = messages.find(
      (message) => message.role === "user" && messageText(message).includes("steer body"),
    );
    expect(writer).toBeDefined();
    expect(messageText(writer as Message)).toContain("work context note");
    expect(steerMessage).toBeDefined();
    expect(messageText(steerMessage as Message)).not.toContain("work context note");
  });
});

describe("drain-only start", () => {
  it("claims a pending steer as the run's first user turn, before the assistant", async () => {
    const { thread, inbox, requests, orchestrator, repos } = await setup();
    const message = await inbox.enqueue(steer("wake me", thread.id));

    const events = await collectEvents(
      await orchestrator.runTurn({ threadId: thread.id, drain: true }),
    );

    expect(events.some((event) => event.type === "turn.error")).toBe(false);
    expect(requests).toHaveLength(1);
    expect(messageTexts(requests[0]?.messages ?? [])).toContain("wake me");

    const turns = await repos.turns.listByThread(thread.id);
    const steerTurn = turns.find((turn) => turn.id === message.id);
    const assistantTurn = turns.find((turn) => turn.role === "assistant");
    expect(steerTurn?.role).toBe("user");
    expect(assistantTurn?.prevTurnId).toBe(message.id);
    expect(await inbox.claimPending(thread.id)).toEqual([]);
  });

  it("chains multiple drained steers before the assistant in enqueue order", async () => {
    const { thread, inbox, orchestrator, repos } = await setup();
    const first = await inbox.enqueue(steer("first", thread.id));
    const second = await inbox.enqueue(steer("second", thread.id));

    await collect(await orchestrator.runTurn({ threadId: thread.id, drain: true }));

    const turns = await repos.turns.listByThread(thread.id);
    expect(turns.find((turn) => turn.id === first.id)?.prevTurnId).toBeNull();
    expect(turns.find((turn) => turn.id === second.id)?.prevTurnId).toBe(first.id);
    expect(turns.find((turn) => turn.role === "assistant")?.prevTurnId).toBe(second.id);
    expect(await inbox.claimPending(thread.id)).toEqual([]);
  });

  it("attaches a system message notice to the drained steer", async () => {
    const { thread, inbox, requests, orchestrator } = await setup();
    await inbox.enqueue(steer("wake me", thread.id));
    await inbox.enqueue(systemMessage("work context note", thread.id));

    await collect(await orchestrator.runTurn({ threadId: thread.id, drain: true }));

    const messages = requests[0]?.messages ?? [];
    const steerMessage = messages.find(
      (message) => message.role === "user" && messageText(message).includes("wake me"),
    );
    expect(steerMessage).toBeDefined();
    expect(messageText(steerMessage as Message)).toContain("work context note");
  });

  it("does nothing and writes no turn when no durable steer is pending", async () => {
    const { thread, orchestrator, repos } = await setup();

    await expect(orchestrator.runTurn({ threadId: thread.id, drain: true })).rejects.toBeInstanceOf(
      NoPendingWakeError,
    );
    expect(await repos.turns.listByThread(thread.id)).toEqual([]);
  });

  it("does not re-append a redelivered steer already persisted by a crashed run", async () => {
    const { thread, inbox, orchestrator, repos } = await setup({ errorAtCall: 1 });
    const message = await inbox.enqueue(steer("crash safe", thread.id));

    // First drain persists the steer, then the provider fails before the ack.
    await collect(await orchestrator.runTurn({ threadId: thread.id, drain: true }));
    expect(await inbox.claimPending(thread.id)).toHaveLength(1);

    // Second drain re-claims the same steer, sees the known turn, continues from
    // it, and acks it without a duplicate turn.
    await collect(await orchestrator.runTurn({ threadId: thread.id, drain: true }));

    const turns = await repos.turns.listByThread(thread.id);
    expect(turns.filter((turn) => turn.id === message.id)).toHaveLength(1);
    expect(await inbox.claimPending(thread.id)).toEqual([]);
  });
});
