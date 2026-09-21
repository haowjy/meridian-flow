/** Loop-level inbox drain: batch delivery, request-only rendering, and the final-claim continuation. */

import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createInMemoryCreditLedger } from "../../../billing/index.js";
import { createInMemoryAccountSkillInstallStore } from "../../../packages/index.js";
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
import { activatedSkillMetadata } from "../activated-skills.js";
import { createOrchestrator } from "../orchestrator.js";
import type { MessageDraft } from "../ports.js";
import type { ReferenceReader } from "../reference-context.js";
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

function message(key: string, threadId: ThreadId): MessageDraft {
  return {
    threadId,
    intent: "message",
    provenance: { kind: "writer", actorId: USER_ID },
    body: { kind: "text", text: key },
    idempotencyKey: key,
  };
}

function notice(key: string, threadId: ThreadId): MessageDraft {
  return {
    threadId,
    intent: "notice",
    provenance: { kind: "system", source: "work" },
    body: { kind: "context", parts: [{ source: "work", text: key }] },
    idempotencyKey: key,
  };
}

/**
 * Mirrors the writer producer's persist-at-enqueue: the user turn with its
 * activated-skill metadata, its blocks, and the inbox `message` all share one id.
 */
async function persistWriterSend(input: {
  repos: ReturnType<typeof createInMemoryRepositories>;
  inbox: ReturnType<typeof createInMemoryInbox>;
  threadId: ThreadId;
  text: string;
  activatedSkillSlugs?: readonly string[];
}): Promise<TurnId> {
  const turnId = crypto.randomUUID() as TurnId;
  const leafTurnId = (await input.repos.threads.findById(input.threadId))?.activeLeafTurnId ?? null;
  await input.repos.turns.create({
    id: turnId,
    threadId: input.threadId,
    prevTurnId: leafTurnId,
    role: "user",
    status: "complete",
    metadata: activatedSkillMetadata(input.activatedSkillSlugs ?? []),
  });
  await input.repos.blocks.create({
    id: `${turnId}:0`,
    turnId,
    blockType: "text",
    sequence: 0,
    textContent: input.text,
  });
  await input.inbox.enqueue({
    id: turnId,
    threadId: input.threadId,
    intent: "message",
    provenance: { kind: "writer", actorId: USER_ID },
    body: { kind: "text", text: input.text },
    idempotencyKey: turnId,
  });
  return turnId;
}

function messageTexts(messages: readonly Message[]): string[] {
  return messages.flatMap((message) =>
    message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
  );
}

function messageText(message: Message): string {
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function messageTurns(turns: readonly { role: string; metadata?: unknown }[]) {
  return turns.filter(
    (turn) =>
      turn.role === "user" && (turn.metadata as { kind?: string } | null)?.kind === "message",
  );
}

async function setup(
  options: {
    onStream?: (call: number) => Promise<void>;
    results?: GenerateResult[];
    errorAtCall?: number;
    /** Seeds an account-installed skill so `/skill` activation can resolve a body. */
    skill?: { slug: string; name: string; description: string; body: string };
    referenceReader?: ReferenceReader;
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
  const accountSkillInstalls = createInMemoryAccountSkillInstallStore();
  if (options.skill) {
    await accountSkillInstalls.insert({ ownerUserId: USER_ID as never, ...options.skill });
  }
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
      accountSkillInstalls,
      ...(options.referenceReader ? { referenceReader: options.referenceReader } : {}),
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
    await inbox.enqueue(message("first steer", thread.id));
    await inbox.enqueue(message("second steer", thread.id));

    await collect(await orchestrator.runTurn({ threadId: thread.id, userText: "hello" }));

    expect(requests).toHaveLength(1);
    const texts = messageTexts(requests[0].messages);
    expect(texts).toContain("first steer");
    expect(texts).toContain("second steer");
    expect(await inbox.claimPending(thread.id)).toEqual([]);
  });

  it("renders a notice as a request-only notice without persisting a turn", async () => {
    const { thread, inbox, requests, orchestrator, repos } = await setup();
    await inbox.enqueue(notice("work context note", thread.id));

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
        if (call === 1) await inbox.enqueue(message("late steer", thread.id));
      },
    });

    await collect(await orchestrator.runTurn({ threadId: thread.id, userText: "hello" }));

    expect(requests).toHaveLength(2);
    expect(messageTexts(requests[1].messages)).toContain("late steer");
    expect(await inbox.claimPending(thread.id)).toEqual([]);
  });

  it("inlines a mid-run writer-activated skill body on the adopted message", async () => {
    const { thread, inbox, requests, orchestrator, repos } = await setup({
      skill: {
        slug: "writing-principles",
        name: "Writing Principles",
        description: "Craft rules for revision",
        body: "Show, do not tell.",
      },
      onStream: async (call) => {
        if (call === 1) {
          await persistWriterSend({
            repos,
            inbox,
            threadId: thread.id,
            text: "also tighten the dialogue",
            activatedSkillSlugs: ["writing-principles"],
          });
        }
      },
    });

    await collect(await orchestrator.runTurn({ threadId: thread.id, userText: "hello" }));

    expect(requests).toHaveLength(2);
    const texts = messageTexts(requests[1]?.messages ?? []);
    expect(texts.some((text) => text.includes("also tighten the dialogue"))).toBe(true);
    expect(texts.some((text) => text.includes("skill invoked: writing-principles"))).toBe(true);
    expect(texts.some((text) => text.includes("Show, do not tell."))).toBe(true);
  });

  it("persists a drained message as a user turn the next iteration still sees", async () => {
    const { thread, inbox, requests, orchestrator, repos } = await setup({
      results: [toolCallResult("ask_user", "call-1"), textResult("done")],
    });
    await inbox.enqueue(message("carry me", thread.id));

    await collect(await orchestrator.runTurn({ threadId: thread.id, userText: "hello" }));

    expect(requests).toHaveLength(2);
    expect(messageTexts(requests[0].messages)).toContain("carry me");
    // The message was acked at the end of iteration 1; iteration 2 only sees it
    // because it persisted as a user-role turn, not as a request-only render.
    expect(messageTexts(requests[1].messages)).toContain("carry me");

    const turns = await repos.turns.listByThread(thread.id);
    const messageTurn = turns.find(
      (turn) =>
        turn.role === "user" && (turn.metadata as { kind?: string } | null)?.kind === "message",
    );
    expect(messageTurn).toBeDefined();
    const blocks = await repos.blocks.listByTurn(messageTurn?.id as string);
    expect(blocks.some((block) => block.textContent === "carry me")).toBe(true);
    expect(await inbox.claimPending(thread.id)).toEqual([]);
  });

  it("redelivers an unacked message once, without a second turn or render", async () => {
    const { thread, inbox, requests, orchestrator, repos } = await setup({ errorAtCall: 1 });
    await inbox.enqueue(message("crash safe", thread.id));

    // First run drains and persists the message, then fails before the response
    // acks it, so the message stays pending for the next run.
    await collect(await orchestrator.runTurn({ threadId: thread.id, userText: "first" }));
    expect(await inbox.claimPending(thread.id)).toHaveLength(1);
    let turns = await repos.turns.listByThread(thread.id);
    expect(messageTurns(turns)).toHaveLength(1);

    // Second run re-claims the same message; the known-turn filter suppresses a
    // re-render and a re-append, and the successful response acks it.
    await collect(await orchestrator.runTurn({ threadId: thread.id, userText: "second" }));

    turns = await repos.turns.listByThread(thread.id);
    expect(messageTurns(turns)).toHaveLength(1);
    const secondRequest = requests[1];
    expect(secondRequest).toBeDefined();
    const renderCount = messageTexts(secondRequest?.messages ?? []).filter(
      (text) => text === "crash safe",
    ).length;
    expect(renderCount).toBe(1);
    expect(await inbox.claimPending(thread.id)).toEqual([]);
  });

  it("persists a message on a second run of an already-baked thread", async () => {
    const { thread, inbox, orchestrator, repos } = await setup();

    // First run freezes the prompt (`bakedSkillSlugs` becomes non-null), so the
    // second run's assembly reuses the stale thread loaded at run start instead
    // of refreshing it from the bake.
    await collect(await orchestrator.runTurn({ threadId: thread.id, userText: "first" }));
    expect((await repos.threads.findById(thread.id))?.bakedSkillSlugs).not.toBeNull();

    await inbox.enqueue(message("baked steer", thread.id));

    const events = await collectEvents(
      await orchestrator.runTurn({ threadId: thread.id, userText: "second" }),
    );

    expect(events.some((event) => event.type === "turn.error")).toBe(false);
    const turns = await repos.turns.listByThread(thread.id);
    expect(messageTurns(turns)).toHaveLength(1);
    expect(await inbox.claimPending(thread.id)).toEqual([]);
  });

  it("attaches a pre-turn notice to the writer message, not a drained message", async () => {
    const { thread, inbox, requests, orchestrator } = await setup();
    await inbox.enqueue(notice("work context note", thread.id));
    await inbox.enqueue(message("steer body", thread.id));

    await collect(await orchestrator.runTurn({ threadId: thread.id, userText: "hello" }));

    const messages = requests[0]?.messages ?? [];
    const writer = messages.find(
      (message) => message.role === "user" && messageText(message).includes("hello"),
    );
    const messageEntry = messages.find(
      (message) => message.role === "user" && messageText(message).includes("steer body"),
    );
    expect(writer).toBeDefined();
    expect(messageText(writer as Message)).toContain("work context note");
    expect(messageEntry).toBeDefined();
    expect(messageText(messageEntry as Message)).not.toContain("work context note");
  });
});

describe("drain-only start", () => {
  it("claims a pending message as the run's first user turn, before the assistant", async () => {
    const { thread, inbox, requests, orchestrator, repos } = await setup();
    const inboxMessage = await inbox.enqueue(message("wake me", thread.id));

    const events = await collectEvents(
      await orchestrator.runTurn({ threadId: thread.id, drain: true }),
    );

    expect(events.some((event) => event.type === "turn.error")).toBe(false);
    expect(requests).toHaveLength(1);
    expect(messageTexts(requests[0]?.messages ?? [])).toContain("wake me");

    const turns = await repos.turns.listByThread(thread.id);
    const messageTurn = turns.find((turn) => turn.id === inboxMessage.id);
    const assistantTurn = turns.find((turn) => turn.role === "assistant");
    expect(messageTurn?.role).toBe("user");
    expect(assistantTurn?.prevTurnId).toBe(inboxMessage.id);
    expect(await inbox.claimPending(thread.id)).toEqual([]);
  });

  it("chains multiple drained messages before the assistant in enqueue order", async () => {
    const { thread, inbox, orchestrator, repos } = await setup();
    const first = await inbox.enqueue(message("first", thread.id));
    const second = await inbox.enqueue(message("second", thread.id));

    await collect(await orchestrator.runTurn({ threadId: thread.id, drain: true }));

    const turns = await repos.turns.listByThread(thread.id);
    expect(turns.find((turn) => turn.id === first.id)?.prevTurnId).toBeNull();
    expect(turns.find((turn) => turn.id === second.id)?.prevTurnId).toBe(first.id);
    expect(turns.find((turn) => turn.role === "assistant")?.prevTurnId).toBe(second.id);
    expect(await inbox.claimPending(thread.id)).toEqual([]);
  });

  it("attaches a notice to the drained message", async () => {
    const { thread, inbox, requests, orchestrator } = await setup();
    await inbox.enqueue(message("wake me", thread.id));
    await inbox.enqueue(notice("work context note", thread.id));

    await collect(await orchestrator.runTurn({ threadId: thread.id, drain: true }));

    const messages = requests[0]?.messages ?? [];
    const messageEntry = messages.find(
      (message) => message.role === "user" && messageText(message).includes("wake me"),
    );
    expect(messageEntry).toBeDefined();
    expect(messageText(messageEntry as Message)).toContain("work context note");
  });

  it("does nothing and writes no turn when no durable message is pending", async () => {
    const { thread, orchestrator, repos } = await setup();

    await expect(orchestrator.runTurn({ threadId: thread.id, drain: true })).rejects.toBeInstanceOf(
      NoPendingWakeError,
    );
    expect(await repos.turns.listByThread(thread.id)).toEqual([]);
  });

  it("does not re-append a redelivered message already persisted by a crashed run", async () => {
    const { thread, inbox, orchestrator, repos } = await setup({ errorAtCall: 1 });
    const inboxMessage = await inbox.enqueue(message("crash safe", thread.id));

    // First drain persists the message, then the provider fails before the ack.
    await collect(await orchestrator.runTurn({ threadId: thread.id, drain: true }));
    expect(await inbox.claimPending(thread.id)).toHaveLength(1);

    // Second drain re-claims the same message, sees the known turn, continues from
    // it, and acks it without a duplicate turn.
    await collect(await orchestrator.runTurn({ threadId: thread.id, drain: true }));

    const turns = await repos.turns.listByThread(thread.id);
    expect(turns.filter((turn) => turn.id === inboxMessage.id)).toHaveLength(1);
    expect(await inbox.claimPending(thread.id)).toEqual([]);
  });

  it("inlines the writer-activated skill body read back off the persisted turn", async () => {
    const { thread, inbox, requests, orchestrator, repos } = await setup({
      skill: {
        slug: "writing-principles",
        name: "Writing Principles",
        description: "Craft rules for revision",
        body: "Show, do not tell.",
      },
    });
    await persistWriterSend({
      repos,
      inbox,
      threadId: thread.id,
      text: "help me revise this scene",
      activatedSkillSlugs: ["writing-principles"],
    });

    await collect(await orchestrator.runTurn({ threadId: thread.id, drain: true }));

    expect(requests).toHaveLength(1);
    const texts = messageTexts(requests[0]?.messages ?? []);
    expect(texts.some((text) => text.includes("skill invoked: writing-principles"))).toBe(true);
    expect(texts.some((text) => text.includes("Show, do not tell."))).toBe(true);
  });
});
