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

async function setup(
  options: { onStream?: (call: number) => Promise<void>; results?: GenerateResult[] } = {},
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
});
