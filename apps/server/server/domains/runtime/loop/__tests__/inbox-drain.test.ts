/** Loop-level inbox drain: batch delivery, request-only rendering, and the final-claim continuation. */

import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryAccountSkillInstallStore } from "../../../packages/index.js";
import type { GenerateResult, Message } from "../../gateway/index.js";
import { createReportPublisher } from "../../spawn/report-publisher.js";
import {
  createSpawnToolRegistrations,
  createToolExecutor,
  createToolRegistry,
} from "../../tools/index.js";
import type { MessageDraft } from "../ports.js";
import type { ReferenceReader } from "../reference-context.js";
import { NoPendingWakeError } from "../run-turn-port.js";
import { createTestAgentBinding } from "./runtime-fixtures.js";
import { runtimeScenario } from "./runtime-harness.js";
import { scriptedGateway } from "./test-gateway.js";

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

function toolCallResult(
  toolName: string,
  toolCallId: string,
  input: Record<string, unknown> = {},
): GenerateResult {
  return {
    content: [{ type: "tool_use", toolCallId, toolName, input }],
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
    child?: boolean;
    realSpawnTools?: boolean;
    imageAssets?: import("../../ports/image-asset.js").ImageAssetPort;
  } = {},
) {
  const accountSkillInstalls = createInMemoryAccountSkillInstallStore();
  if (options.skill) await accountSkillInstalls.insert({ ownerUserId: USER_ID, ...options.skill });
  const gateway = scriptedGateway(options);
  const { requests } = gateway;
  const toolRegistry = createToolRegistry();
  if (options.realSpawnTools) {
    for (const registration of createSpawnToolRegistrations()) toolRegistry.register(registration);
  }
  const rig = await runtimeScenario({
    gateway,
    accountSkillInstalls,
    ...(options.realSpawnTools
      ? { toolExecutor: createToolExecutor(toolRegistry), toolRegistry }
      : {}),
    ...(options.referenceReader ? { referenceReader: options.referenceReader } : {}),
    ...(options.imageAssets ? { imageAssets: options.imageAssets } : {}),
    agentRevisions: createTestAgentBinding("gpt-4.1-mini", "", () => [thread.id]),
  });
  const thread = options.child
    ? await rig.repos.threads.createSubagent({
        userId: USER_ID,
        projectId: rig.project.id,
        parentThreadId: rig.thread.id,
        rootThreadId: rig.thread.id,
        spawnDepth: 1,
      })
    : rig.thread;
  return { ...rig, thread, requests };
}

async function execute(run: import("../run-turn-port.js").PreparedRun) {
  return run.execute();
}

describe("inbox drain", () => {
  it("keeps return_result capture run-scoped without ending the steered turn's tool loop", async () => {
    const { thread, inbox, requests, orchestrator, repos } = await setup({
      onStream: async (call) => {
        if (call === 1) await inbox.enqueue(message("steer after report", thread.id));
      },
      child: true,
      realSpawnTools: true,
      results: [
        toolCallResult("return_result", "rr-1", {
          summary: "explicit summary",
          payload: { answer: 42 },
        }),
        toolCallResult("unknown", "repair-me"),
        textResult("steered answer after tool"),
      ],
    });
    const run = await orchestrator.prepare({ threadId: thread.id, userText: "report" });
    await execute(run);
    expect(requests).toHaveLength(3);
    const turns = await repos.turns.listByThread(thread.id);
    const terminal = turns.at(-1);
    expect(terminal?.id).not.toBe(run.assistantTurnId);
    expect(terminal?.finishReason).toBe("end_turn");
    const report = await repos.executionReports.findByExecution(thread.id, run.assistantTurnId);
    expect(report).toMatchObject({
      outcome: "succeeded",
      source: "return_result",
      summary: "explicit summary",
      payload: { answer: 42 },
      captureToolCallId: "rr-1",
      terminalAssistantTurnId: terminal?.id,
    });
    const toolResults = (await repos.blocks.listByTurn(run.assistantTurnId)).filter(
      (block) => block.blockType === "tool_result",
    );
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.content).toMatchObject({ output: { ok: true }, isError: false });
  });

  it("saves only the final response's public text and per-execution response cost", async () => {
    const { thread, orchestrator, repos } = await setup({
      child: true,
      results: [textResult("first result"), textResult("second result")],
    });
    const first = await orchestrator.prepare({ threadId: thread.id, userText: "first" });
    await execute(first);
    const firstReport = await repos.executionReports.findByExecution(
      thread.id,
      first.assistantTurnId,
    );
    expect(firstReport).toMatchObject({
      outcome: "succeeded",
      source: "final_assistant",
      summary: "first result",
      publication: "none",
    });
    expect(firstReport?.costMillicredits).toBeGreaterThan(0);

    const second = await orchestrator.prepare({ threadId: thread.id, userText: "second" });
    await execute(second);
    const secondReport = await repos.executionReports.findByExecution(
      thread.id,
      second.assistantTurnId,
    );
    expect(secondReport).toMatchObject({
      outcome: "succeeded",
      source: "final_assistant",
      summary: "second result",
      costMillicredits: firstReport?.costMillicredits,
    });
  });

  it("saves an empty successful report rather than an invented incomplete fallback", async () => {
    const { thread, orchestrator, repos } = await setup({ child: true, results: [textResult("")] });
    const run = await orchestrator.prepare({ threadId: thread.id, userText: "empty" });
    await execute(run);
    expect(
      await repos.executionReports.findByExecution(thread.id, run.assistantTurnId),
    ).toMatchObject({
      outcome: "succeeded",
      source: "empty",
      summary: "",
      publication: "none",
    });
  });

  it("treats token exhaustion as failure while retaining durable public text", async () => {
    const exhausted = { ...textResult("partial prose"), finishReason: "max_tokens" as const };
    const { thread, orchestrator, repos } = await setup({ child: true, results: [exhausted] });
    const run = await orchestrator.prepare({ threadId: thread.id, userText: "long" });
    await execute(run);
    expect(
      await repos.executionReports.findByExecution(thread.id, run.assistantTurnId),
    ).toMatchObject({
      outcome: "failed",
      reason: "max_tokens",
      source: "final_assistant",
      summary: "partial prose",
    });
  });

  it("admits exact child executions for writer and queued continuations before returning a handle", async () => {
    const { thread, inbox, orchestrator, repos } = await setup({ child: true });
    const writer = await orchestrator.prepare({ threadId: thread.id, userText: "writer prompt" });
    expect(
      await repos.executionReports.findByExecution(thread.id, writer.assistantTurnId),
    ).toMatchObject({
      assistantTurnId: writer.assistantTurnId,
      deliveryMode: "none",
      origin: "thread_run",
      outcome: null,
    });
    await execute(writer);

    await inbox.enqueue(message("queued prompt", thread.id));
    const queued = await orchestrator.prepare({ threadId: thread.id, drain: true });
    expect(
      await repos.executionReports.findByExecution(thread.id, queued.assistantTurnId),
    ).toMatchObject({
      assistantTurnId: queued.assistantTurnId,
      deliveryMode: "none",
      origin: "thread_run",
      outcome: null,
    });
    expect(queued.assistantTurnId).not.toBe(writer.assistantTurnId);
    await execute(queued);
  });

  it("renders a notice as a request-only notice without persisting a turn", async () => {
    const { thread, inbox, requests, orchestrator, repos } = await setup();
    await inbox.enqueue(notice("work context note", thread.id));

    await execute(await orchestrator.prepare({ threadId: thread.id, userText: "hello" }));

    const texts = messageTexts(requests[0].messages);
    expect(texts.some((text) => text.includes("work context note"))).toBe(true);
    // The run's own user + assistant turns are the only persisted turns.
    expect(await repos.turns.listByThread(thread.id)).toHaveLength(2);
    expect(await inbox.selectPending(thread.id)).toEqual([]);
  });

  it("inlines a mid-run writer-activated skill body on the adopted message", async () => {
    const { thread, requests, orchestrator, send } = await setup({
      skill: {
        slug: "writing-principles",
        name: "Writing Principles",
        description: "Craft rules for revision",
        body: "Show, do not tell.",
      },
      onStream: async (call) => {
        if (call === 1) {
          await send(thread.id, "also tighten the dialogue", {
            activatedSkillSlugs: ["writing-principles"],
          });
        }
      },
    });

    await execute(await orchestrator.prepare({ threadId: thread.id, userText: "hello" }));

    expect(requests).toHaveLength(2);
    const texts = messageTexts(requests[1]?.messages ?? []);
    expect(texts.some((text) => text.includes("also tighten the dialogue"))).toBe(true);
    expect(texts.some((text) => text.includes("skill invoked: writing-principles"))).toBe(true);
    expect(texts.some((text) => text.includes("Show, do not tell."))).toBe(true);
  });

  it("reads a mid-run adopted message's references into the request and the turn", async () => {
    const documentId = "33333333-3333-4333-8333-333333333333";
    const uri = "uploads://@/gate-map.png";
    let adoptedTurnId: TurnId | undefined;
    const { thread, requests, orchestrator, repos, send } = await setup({
      imageAssets: {
        async resolve() {
          return { mediaType: "image/png", data: "aW1hZ2U=", sizeBytes: 5 };
        },
      },
      referenceReader: {
        async read(reference) {
          return { uri: reference.uri, pages: [1] };
        },
      },
      onStream: async (call) => {
        if (call === 1) {
          adoptedTurnId = (
            await send(thread.id, "compare with [[Gate Map]]", {
              blocks: [
                { type: "reference", documentId, uri, text: "[[Gate Map]]" },
                { type: "image", documentId: "44444444-4444-4444-8444-444444444444", uri },
              ],
            })
          ).userTurnId;
        }
      },
    });

    await execute(await orchestrator.prepare({ threadId: thread.id, userText: "hello" }));

    expect(requests).toHaveLength(2);
    const texts = messageTexts(requests[1]?.messages ?? []);
    expect(texts.some((text) => text.includes(`Reference read result for ${uri}`))).toBe(true);

    const blocks = await repos.blocks.listByTurn(adoptedTurnId as TurnId);
    const referenceBlock = blocks.find(
      (block) => (block.content as { type?: string } | null)?.type === "reference",
    );
    expect(referenceBlock?.content).toMatchObject({ read: { result: { uri, pages: [1] } } });
    expect(blocks.find((block) => block.blockType === "image")?.content).toMatchObject({
      type: "image_reference",
      documentId: "44444444-4444-4444-8444-444444444444",
      uri,
    });
    expect(requests[1].messages.flatMap((message) => message.content)).toContainEqual({
      type: "image_reference",
      documentId: "44444444-4444-4444-8444-444444444444",
      uri,
    });
    expect(messageTexts(requests[1].messages)).not.toContain("compare with [[Gate Map]]");
  });

  it("persists a drained message as a user turn the next iteration still sees", async () => {
    const { thread, inbox, requests, orchestrator, repos } = await setup({
      results: [toolCallResult("ask_user", "call-1"), textResult("done")],
    });
    await inbox.enqueue(message("carry me", thread.id));

    await execute(await orchestrator.prepare({ threadId: thread.id, userText: "hello" }));

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
    expect(await inbox.selectPending(thread.id)).toEqual([]);
  });

  it("redelivers an unacked message once, without a second turn or render", async () => {
    const { thread, inbox, requests, orchestrator, repos } = await setup({ errorAtCall: 1 });
    await inbox.enqueue(message("crash safe", thread.id));

    // First run drains and persists the message, then fails before the response
    // acks it, so the message stays pending for the next run.
    await execute(await orchestrator.prepare({ threadId: thread.id, userText: "first" }));
    expect(await inbox.selectPending(thread.id)).toHaveLength(1);
    let turns = await repos.turns.listByThread(thread.id);
    expect(messageTurns(turns)).toHaveLength(1);

    // Second run re-claims the same message; the known-turn filter suppresses a
    // re-render and a re-append, and the successful response acks it.
    await execute(await orchestrator.prepare({ threadId: thread.id, userText: "second" }));

    turns = await repos.turns.listByThread(thread.id);
    expect(messageTurns(turns)).toHaveLength(1);
    const secondRequest = requests[1];
    expect(secondRequest).toBeDefined();
    const renderCount = messageTexts(secondRequest?.messages ?? []).filter(
      (text) => text === "crash safe",
    ).length;
    expect(renderCount).toBe(1);
    expect(await inbox.selectPending(thread.id)).toEqual([]);
  });

  it("persists a message on a second run of an already-baked thread", async () => {
    const { thread, inbox, orchestrator, repos } = await setup();

    // First run freezes the prompt (`bakedSkillSlugs` becomes non-null), so the
    // second run's assembly reuses the stale thread loaded at run start instead
    // of refreshing it from the bake.
    await execute(await orchestrator.prepare({ threadId: thread.id, userText: "first" }));
    expect((await repos.threads.findById(thread.id))?.bakedSkillSlugs).not.toBeNull();

    await inbox.enqueue(message("baked steer", thread.id));

    const outcome = await execute(
      await orchestrator.prepare({ threadId: thread.id, userText: "second" }),
    );

    expect(outcome.status).toBe("complete");
    const turns = await repos.turns.listByThread(thread.id);
    expect(messageTurns(turns)).toHaveLength(1);
    expect(await inbox.selectPending(thread.id)).toEqual([]);
  });

  it("attaches a boundary notice to the adopted message before the new assistant", async () => {
    const { thread, inbox, requests, orchestrator } = await setup();
    await inbox.enqueue(notice("work context note", thread.id));
    await inbox.enqueue(message("steer body", thread.id));

    await execute(await orchestrator.prepare({ threadId: thread.id, userText: "hello" }));

    const messages = requests[0]?.messages ?? [];
    const writer = messages.find(
      (message) => message.role === "user" && messageText(message).includes("hello"),
    );
    const messageEntry = messages.find(
      (message) => message.role === "user" && messageText(message).includes("steer body"),
    );
    expect(writer).toBeDefined();
    expect(messageText(writer as Message)).not.toContain("work context note");
    expect(messageEntry).toBeDefined();
    expect(messageText(messageEntry as Message)).toContain("work context note");
  });
});

describe("drain-only start", () => {
  it("claims a pending message as the run's first user turn, before the assistant", async () => {
    const { thread, inbox, requests, orchestrator, repos } = await setup();
    const inboxMessage = await inbox.enqueue(message("wake me", thread.id));

    const outcome = await execute(await orchestrator.prepare({ threadId: thread.id, drain: true }));

    expect(outcome.status).toBe("complete");
    expect(requests).toHaveLength(1);
    expect(messageTexts(requests[0]?.messages ?? [])).toContain("wake me");

    const turns = await repos.turns.listByThread(thread.id);
    const messageTurn = turns.find((turn) => turn.id === inboxMessage.id);
    const assistantTurn = turns.find((turn) => turn.role === "assistant");
    expect(messageTurn?.role).toBe("user");
    expect(assistantTurn?.prevTurnId).toBe(inboxMessage.id);
    expect(await inbox.selectPending(thread.id)).toEqual([]);
  });

  it("delivers a hidden system notification without copying the saved report body", async () => {
    const rig = await setup();
    const { thread, repos, orchestrator, requests, delivery, deps } = rig;
    const callerTurn = await repos.turns.create({
      threadId: thread.id,
      role: "assistant",
      status: "complete",
      prevTurnId: null,
    });
    const child = await repos.threads.createSubagent({
      userId: thread.userId,
      projectId: thread.projectId,
      parentThreadId: thread.id,
      rootThreadId: thread.id,
      spawnDepth: 1,
    });
    const execution = await repos.turns.create({
      threadId: child.id,
      role: "assistant",
      status: "complete",
      prevTurnId: null,
    });
    await repos.executionReports.admit({
      childThreadId: child.id,
      assistantTurnId: execution.id,
      handle: child.ref ?? "",
      origin: "spawn",
      deliveryMode: "background_notification",
      callerThreadId: thread.id,
      callerTurnId: callerTurn.id,
      toolCallId: "spawn-1",
      cardBlockId: null,
    });
    const secret = "DISTINCTIVE_CHAPTER_BODY_omega_17";
    await repos.executionReports.finalizeOnce({
      childThreadId: child.id,
      assistantTurnId: execution.id,
      outcome: "succeeded",
      reason: null,
      source: "return_result",
      summary: secret,
      payload: { chapter: secret },
    });
    await createReportPublisher({
      repos,
      eventWriter: deps.eventWriter,
      eventSink: deps.eventSink,
      delivery,
    }).publish(child.id, execution.id);
    const [queued] = await delivery.selectPending(thread.id);
    await execute(await orchestrator.prepare({ threadId: thread.id, drain: true }));
    expect(await repos.turns.findById(queued.id)).toMatchObject({ role: "system" });
    const blocks = await repos.blocks.listByTurn(queued.id);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ blockType: "text" });
    const notification = requests[0].messages.find(
      (message) => message.role === "system" && messageText(message).includes(execution.id),
    );
    expect(messageText(notification as Message)).toContain(`"execution":"${execution.id}"`);
    expect(
      JSON.stringify([queued, blocks, requests, rig.projectedEvents.map(({ event }) => event)]),
    ).not.toContain(secret);
    expect(await delivery.selectPending(thread.id)).toEqual([]);
  });

  it("chains multiple drained messages before the assistant in enqueue order", async () => {
    const { thread, inbox, orchestrator, repos } = await setup();
    const enqueuedAt = new Date("2020-01-02T03:04:05.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(enqueuedAt);
    const first = await inbox.enqueue(message("first", thread.id));
    vi.useRealTimers();
    const second = await inbox.enqueue(message("second", thread.id));

    await execute(await orchestrator.prepare({ threadId: thread.id, drain: true }));

    const turns = await repos.turns.listByThread(thread.id);
    expect(turns.find((turn) => turn.id === first.id)?.prevTurnId).toBeNull();
    expect(turns.find((turn) => turn.id === first.id)?.createdAt).toBe(enqueuedAt.toISOString());
    expect(turns.find((turn) => turn.id === second.id)?.prevTurnId).toBe(first.id);
    expect(turns.find((turn) => turn.role === "assistant")?.prevTurnId).toBe(second.id);
    expect(await inbox.selectPending(thread.id)).toEqual([]);
  });

  it("attaches a notice to the drained message", async () => {
    const { thread, inbox, requests, orchestrator } = await setup();
    await inbox.enqueue(message("wake me", thread.id));
    await inbox.enqueue(notice("work context note", thread.id));

    await execute(await orchestrator.prepare({ threadId: thread.id, drain: true }));

    const messages = requests[0]?.messages ?? [];
    const messageEntry = messages.find(
      (message) => message.role === "user" && messageText(message).includes("wake me"),
    );
    expect(messageEntry).toBeDefined();
    expect(messageText(messageEntry as Message)).toContain("work context note");
  });

  it("does nothing and writes no turn when no durable message is pending", async () => {
    const { thread, orchestrator, repos } = await setup();

    await expect(orchestrator.prepare({ threadId: thread.id, drain: true })).rejects.toBeInstanceOf(
      NoPendingWakeError,
    );
    expect(await repos.turns.listByThread(thread.id)).toEqual([]);
  });

  it("does not re-append a redelivered message already persisted by a crashed run", async () => {
    const { thread, inbox, orchestrator, repos } = await setup({ errorAtCall: 1 });
    const inboxMessage = await inbox.enqueue(message("crash safe", thread.id));

    // First drain persists the message, then the provider fails before the ack.
    await execute(await orchestrator.prepare({ threadId: thread.id, drain: true }));
    expect(await inbox.selectPending(thread.id)).toHaveLength(1);

    // Second drain re-claims the same message, sees the known turn, continues from
    // it, and acks it without a duplicate turn.
    await execute(await orchestrator.prepare({ threadId: thread.id, drain: true }));

    const turns = await repos.turns.listByThread(thread.id);
    expect(turns.filter((turn) => turn.id === inboxMessage.id)).toHaveLength(1);
    expect(await inbox.selectPending(thread.id)).toEqual([]);
  });

  it("inlines the writer-activated skill body read back off the persisted turn", async () => {
    const { thread, requests, orchestrator, send, inbox, repos } = await setup({
      skill: {
        slug: "writing-principles",
        name: "Writing Principles",
        description: "Craft rules for revision",
        body: "Show, do not tell.",
      },
    });
    const sent = await send(thread.id, "help me revise this scene", {
      activatedSkillSlugs: ["writing-principles"],
    });

    const fresh = await inbox.enqueue(message("fresh after saved writer", thread.id));
    const run = await orchestrator.prepare({ threadId: thread.id, drain: true });
    await run.execute();
    expect((await repos.turns.findById(fresh.id))?.prevTurnId).toBe(sent.userTurnId);
    expect((await repos.turns.findById(run.assistantTurnId))?.prevTurnId).toBe(fresh.id);

    expect(requests).toHaveLength(1);
    const texts = messageTexts(requests[0]?.messages ?? []);
    expect(texts.some((text) => text.includes("skill invoked: writing-principles"))).toBe(true);
    expect(texts.some((text) => text.includes("Show, do not tell."))).toBe(true);
  });
});
