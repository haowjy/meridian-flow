/** Loop-level inbox drain: batch delivery, request-only rendering, and the final-claim continuation. */

import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Turn } from "@meridian/contracts/threads";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryAccountSkillInstallStore } from "../../../packages/index.js";
import {
  childCompletionMetadata,
  classifyHistoryItem,
  decodeImageInclusionMetadata,
  skillBodyMetadata,
} from "../../../threads/index.js";
import type { Gateway, GenerateResult, Message } from "../../gateway/index.js";
import { ImageAssetResolutionError } from "../../ports/image-asset.js";
import { createReportPublisher } from "../../spawn/report-publisher.js";
import {
  createSpawnToolRegistrations,
  createToolExecutor,
  createToolRegistry,
} from "../../tools/index.js";
import type { MessageDraft } from "../ports.js";
import type { ReferenceReader } from "../reference-context.js";
import { createTestAgentBinding, createTestNoticePort } from "./runtime-fixtures.js";
import { runtimeScenario } from "./runtime-harness.js";
import { scriptedGateway } from "./test-gateway.js";

const USER_ID = "user-1";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a value");
  return value;
}

function textResult(text = "done"): GenerateResult {
  return {
    content: [{ type: "text", text }],
    toolCalls: [],
    finishReason: "end_turn",
    usage: { inputTokens: 1000, outputTokens: 100 },
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
    usage: { inputTokens: 1000, outputTokens: 100 },
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

function messageTexts(messages: readonly Message[]): string[] {
  return messages.flatMap((message) =>
    message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
  );
}

function messageText(message: Message): string {
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function imageReference(uri: string) {
  return {
    type: "image" as const,
    documentId: "44444444-4444-4444-8444-000000000099",
    uri,
  };
}

async function recordNotice(notices: ReturnType<typeof createTestNoticePort>, threadId: string) {
  await notices.record({
    kind: "awareness_degraded",
    scope: { kind: "thread", threadId },
    message: "Awareness changed during preparation.",
    data: { documentIds: [], documentNames: [] },
  });
}

function messageTurns(turns: readonly { id: TurnId; role: string; metadata?: unknown }[]) {
  return turns.filter((turn) => turn.role === "user");
}

async function messageTurnTexts(
  repos: Awaited<ReturnType<typeof setup>>["repos"],
  threadId: ThreadId,
): Promise<string[]> {
  const turns = messageTurns(await repos.turns.listByThread(threadId));
  return Promise.all(
    turns.map(async (turn) =>
      (await repos.blocks.listByTurn(turn.id))
        .filter((block) => block.blockType === "text")
        .map((block) => block.textContent ?? "")
        .join("\n"),
    ),
  );
}

async function setup(
  options: {
    onStream?: (call: number) => Promise<void>;
    results?: GenerateResult[];
    /** Seeds an account-installed skill so `/skill` activation can resolve a body. */
    skill?: { slug: string; name: string; description: string; body: string };
    referenceReader?: ReferenceReader;
    child?: boolean;
    realSpawnTools?: boolean;
    supportsImageInput?: boolean;
    imageAssets?: import("../../ports/image-asset.js").ImageAssetPort;
    notices?: ReturnType<typeof createTestNoticePort>;
  } = {},
) {
  const accountSkillInstalls = createInMemoryAccountSkillInstallStore();
  if (options.skill) await accountSkillInstalls.insert({ ownerUserId: USER_ID, ...options.skill });
  const gateway = scriptedGateway({ usage: { inputTokens: 1000, outputTokens: 100 }, ...options });
  const { requests } = gateway;
  const toolRegistry = createToolRegistry();
  if (options.realSpawnTools) {
    for (const registration of createSpawnToolRegistrations()) toolRegistry.register(registration);
  }
  const rig = await runtimeScenario({
    gateway: {
      ...gateway,
      listModels: () => [
        {
          id: "gpt-4.1-mini",
          provider: "openai",
          tokenizer: "o200k" as const,
          displayName: "Test model",
          contextWindow: 128_000,
          maxOutputTokens: 16_384,
          promptCache: { kind: "none", ttlMs: null },
          capabilities: new Set(options.supportsImageInput === false ? [] : ["image_input"]),
        },
      ],
    } satisfies Gateway,
    accountSkillInstalls,
    ...(options.realSpawnTools
      ? { toolExecutor: createToolExecutor(toolRegistry), toolRegistry }
      : {}),
    ...(options.referenceReader ? { referenceReader: options.referenceReader } : {}),
    ...(options.imageAssets ? { imageAssets: options.imageAssets } : {}),
    ...(options.notices ? { notices: options.notices } : {}),
    agentRevisions: createTestAgentBinding("gpt-4.1-mini", "", () => [
      thread.id,
      ...(thread.parentThreadId ? [thread.parentThreadId] : []),
    ]),
  });
  const thread = options.child
    ? await (async () => {
        const originTurn = await rig.repos.turns.create({
          threadId: rig.thread.id,
          role: "assistant",
          origin: "assistant",
          status: "complete",
        });
        return rig.repos.threads.createSubagent({
          userId: USER_ID,
          projectId: rig.project.id,
          parentThreadId: rig.thread.id,
          rootThreadId: rig.thread.id,
          originTurnId: originTurn.id,
          spawnDepth: 1,
        });
      })()
    : rig.thread;
  return { ...rig, thread, requests, notices: options.notices };
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
          artifacts: ["scratch://the-lamplighters-arithmetic.md"],
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
    expect(terminal?.id).not.toBe(run.executionTurnId);
    expect(terminal?.finishReason).toBe("end_turn");
    const report = await repos.executionReports.findByExecution(thread.id, run.executionTurnId);
    expect(report).toMatchObject({
      outcome: "succeeded",
      source: "return_result",
      summary: "explicit summary",
      payload: { answer: 42 },
      artifacts: [{ type: "object", uri: "scratch://the-lamplighters-arithmetic.md" }],
      captureToolCallId: "rr-1",
      terminalTurnId: terminal?.id,
    });
    const toolResults = (await repos.blocks.listByTurn(run.executionTurnId)).filter(
      (block) => block.blockType === "tool_result",
    );
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.content).toMatchObject({ output: { ok: true }, isError: false });
  });

  it("keeps a mid-run writer-activated skill body on its adopted message across iterations", async () => {
    const { thread, requests, orchestrator, repos, send } = await setup({
      results: [textResult("first"), toolCallResult("unknown", "call-1"), textResult("done")],
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

    expect(requests).toHaveLength(3);
    for (const request of requests.slice(1)) {
      const renderedHistory = messageTexts(request.messages).join("\n");
      expect(renderedHistory).toContain("also tighten the dialogue");
      expect(renderedHistory).toContain("skill invoked: writing-principles");
      expect(renderedHistory).toContain("Show, do not tell.");
    }

    // The model still sees the body merged into the steer's own message, but
    // the body is never a block on the writer's own turn: it lives on a
    // separate, hidden `system`-role turn chained right after it. Anything
    // that projects a user turn's text (`UserTurn.tsx`'s `projectUserTurn`,
    // chat previews, fork/handoff copies) reads only the writer's own turns,
    // so a body block placed there would leak into the writer's own bubble.
    const turns = await repos.turns.listByThread(thread.id);
    const userTurns = turns.filter((turn) => turn.role === "user");
    expect(userTurns.length).toBeGreaterThan(0);
    for (const turn of userTurns) {
      const blocks = await repos.blocks.listByTurn(turn.id);
      for (const block of blocks) {
        expect(block.textContent ?? "").not.toContain("skill invoked:");
        expect(block.textContent ?? "").not.toContain("Show, do not tell.");
      }
    }
    const steerTurn = userTurns.find((turn) =>
      Array.isArray(
        (turn.metadata as { activatedSkillSlugs?: unknown } | null)?.activatedSkillSlugs,
      ),
    ) as Turn;
    expect(steerTurn).toBeDefined();
    const skillBodyTurn = turns.find(
      (turn) => classifyHistoryItem(turn).kind === "skill_body",
    ) as Turn;
    expect(skillBodyTurn).toMatchObject({
      role: "system",
      prevTurnId: steerTurn.id,
      metadata: skillBodyMetadata(),
    });
    const skillBodyBlocks = await repos.blocks.listByTurn(skillBodyTurn.id);
    expect(skillBodyBlocks).toHaveLength(1);
    expect(skillBodyBlocks[0]?.blockType).toBe("text");
    expect(skillBodyBlocks[0]?.textContent ?? "").toContain("skill invoked: writing-principles");
  });

  it("fails retryably on a transient image resolve error without deciding the image", async () => {
    const image = {
      type: "image" as const,
      documentId: "44444444-4444-4444-8444-000000000004",
      uri: "uploads://@/temporary-failure.png",
    };
    let resolutions = 0;
    const { thread, requests, orchestrator, repos, send, inbox, journal } = await setup({
      imageAssets: {
        async resolve() {
          resolutions += 1;
          if (resolutions === 1)
            throw new ImageAssetResolutionError("temporary object-store timeout");
          return { mediaType: "image/png", data: "aW1hZ2U=", sizeBytes: 5 };
        },
      },
    });
    await send(thread.id, "retry this image", {
      blocks: [{ type: "text", text: "retry this image" }, image],
    });

    const first = await orchestrator.prepare({ threadId: thread.id, drain: true });
    await expect(first.execute()).resolves.toMatchObject({
      status: "error",
      turn: {
        status: "error",
        error: "This response failed.",
      },
    });
    expect(await repos.turns.findById(first.executionTurnId)).toMatchObject({
      role: "assistant",
      status: "error",
      finishReason: "error",
    });
    expect(await repos.imageInclusions.findByThread(thread.id)).toEqual([]);
    expect(
      (await repos.turns.listByThread(thread.id)).filter(
        (turn) => decodeImageInclusionMetadata(turn.metadata) !== null,
      ),
    ).toHaveLength(0);
    expect(await inbox.selectPending(thread.id)).toEqual([]);
    expect(
      journal
        .getEvents(thread.id)
        .map(({ event }) => event)
        .find((event) => event.type === "turn.error" && event.turn.id === first.executionTurnId),
    ).toMatchObject({
      error: {
        message: "temporary object-store timeout",
        details: { reason: "image_resolution_failed" },
      },
    });

    const retry = await orchestrator.prepare({ threadId: thread.id, userText: "try again" });
    await retry.execute();
    expect(requests).toHaveLength(1);
    expect(
      required(requests[0])
        .messages.flatMap((message) => message.content)
        .some((part) => part.type === "image"),
    ).toBe(true);
    const imageBlock = (await repos.blocks.listByThread(thread.id)).find(
      (block) => block.blockType === "image",
    );
    expect(
      (await repos.imageInclusions.findByThread(thread.id)).find(
        (decision) => decision.blockId === imageBlock?.id,
      )?.included,
    ).toBe(true);
  });

  it.each([
    "drain start",
    "mid-run",
  ] as const)("retries preparation when a second writer send arrives during %s", async (boundary) => {
    const entered = deferred();
    const release = deferred();
    let blockFirstResolution = true;
    let rig: Awaited<ReturnType<typeof setup>>;
    rig = await setup({
      imageAssets: {
        async resolve(_context, reference) {
          if (blockFirstResolution) {
            blockFirstResolution = false;
            entered.resolve();
            await release.promise;
          }
          return { mediaType: "image/png", data: reference.uri, sizeBytes: 5 };
        },
      },
      onStream: async (call) => {
        if (boundary === "mid-run" && call === 1) {
          await rig.send(rig.thread.id, "first steer", {
            blocks: [
              { type: "text", text: "first steer" },
              imageReference("uploads://@/first.png"),
            ],
          });
        }
      },
    });

    let execution: Promise<import("../run-turn-port.js").RunOutcome>;
    if (boundary === "drain start") {
      await rig.send(rig.thread.id, "first writer message", {
        blocks: [
          { type: "text", text: "first writer message" },
          imageReference("uploads://@/first.png"),
        ],
      });
      const preparing = rig.orchestrator.prepare({ threadId: rig.thread.id, drain: true });
      await entered.promise;
      await rig.send(rig.thread.id, "second writer message");
      release.resolve();
      execution = preparing.then((run) => run.execute());
    } else {
      const run = await rig.orchestrator.prepare({ threadId: rig.thread.id, userText: "begin" });
      execution = run.execute();
      await entered.promise;
      await rig.send(rig.thread.id, "second steer");
      release.resolve();
    }

    await expect(execution).resolves.toMatchObject({ status: "complete" });
    const newestRequest = required(rig.requests.at(-1));
    if (boundary === "mid-run") {
      expect(messageTexts(newestRequest.messages)).toContain("first steer");
      expect(messageTexts(newestRequest.messages)).toContain("second steer");
    } else {
      expect(messageTexts(newestRequest.messages)).toContain("second writer message");
      expect(messageTexts(newestRequest.messages)).toContain("first writer message");
    }
    expect(await messageTurnTexts(rig.repos, rig.thread.id)).toEqual(
      boundary === "drain start"
        ? ["first writer message", "second writer message"]
        : ["begin", "first steer", "second steer"],
    );
    expect(await rig.inbox.selectPending(rig.thread.id)).toEqual([]);
  });

  it.each([
    "drain start",
    "mid-run",
  ] as const)("fails the newest writer action and preserves NoticePort rows after %s preparation failure", async (boundary) => {
    const notices = createTestNoticePort();
    let rig: Awaited<ReturnType<typeof setup>>;
    let steerTurnId: string | undefined;
    rig = await setup({
      notices,
      imageAssets: {
        async resolve() {
          throw new ImageAssetResolutionError("temporary object-store timeout");
        },
      },
      onStream: async (call) => {
        if (boundary !== "mid-run" || call !== 1) return;
        await recordNotice(notices, rig.thread.id);
        const sent = await rig.send(rig.thread.id, "steer with image", {
          blocks: [
            { type: "text", text: "steer with image" },
            imageReference("uploads://@/steer-failure.png"),
          ],
        });
        steerTurnId = sent.userTurnId;
      },
    });

    if (boundary === "drain start") {
      await recordNotice(notices, rig.thread.id);
      await rig.send(rig.thread.id, "writer message with image", {
        blocks: [
          { type: "text", text: "writer message with image" },
          imageReference("uploads://@/start-failure.png"),
        ],
      });
      const run = await rig.orchestrator.prepare({ threadId: rig.thread.id, drain: true });
      await expect(run.execute()).resolves.toMatchObject({
        status: "error",
        turn: {
          status: "error",
          error: "This response failed.",
        },
      });
    } else {
      const run = await rig.orchestrator.prepare({ threadId: rig.thread.id, userText: "begin" });
      await expect(run.execute()).resolves.toMatchObject({
        status: "error",
        turn: {
          status: "error",
          error: "This response failed.",
        },
      });
      const turns = await rig.repos.turns.listByThread(rig.thread.id);
      const failedReply = turns.filter((turn) => turn.role === "assistant").at(-1);
      expect(failedReply?.prevTurnId).toBe(steerTurnId);
    }

    expect(await rig.inbox.selectPending(rig.thread.id)).toEqual([]);
    expect(await notices.peek(rig.thread.id)).toHaveLength(1);
  });

  it.each([
    "drain start",
    "mid-run",
  ] as const)("discards preparation without consuming notices or pending messages when cancelled at %s", async (boundary) => {
    const notices = createTestNoticePort();
    const entered = deferred();
    const release = deferred();
    const controller = new AbortController();
    let blockFirstResolution = true;
    let rig: Awaited<ReturnType<typeof setup>>;
    rig = await setup({
      notices,
      imageAssets: {
        async resolve(_context, reference) {
          if (blockFirstResolution) {
            blockFirstResolution = false;
            entered.resolve();
            await release.promise;
          }
          return { mediaType: "image/png", data: reference.uri, sizeBytes: 5 };
        },
      },
      onStream: async (call) => {
        if (boundary !== "mid-run" || call !== 1) return;
        await recordNotice(notices, rig.thread.id);
        await rig.send(rig.thread.id, "steer survives cancellation", {
          blocks: [
            { type: "text", text: "steer survives cancellation" },
            imageReference("uploads://@/cancel.png"),
          ],
        });
      },
    });

    if (boundary === "drain start") {
      await recordNotice(notices, rig.thread.id);
      await rig.send(rig.thread.id, "writer message survives cancellation", {
        blocks: [
          { type: "text", text: "writer message survives cancellation" },
          imageReference("uploads://@/cancel-start.png"),
        ],
      });
      const preparing = rig.orchestrator.prepare({
        threadId: rig.thread.id,
        drain: true,
        signal: controller.signal,
      });
      await entered.promise;
      controller.abort();
      release.resolve();
      await expect(preparing).rejects.toMatchObject({ name: "AbortError" });
    } else {
      const run = await rig.orchestrator.prepare({
        threadId: rig.thread.id,
        userText: "begin",
        signal: controller.signal,
      });
      const execution = run.execute();
      await entered.promise;
      controller.abort();
      release.resolve();
      await expect(execution).resolves.toMatchObject({ status: "cancelled" });
    }
    expect(await rig.inbox.selectPending(rig.thread.id)).toHaveLength(1);
    expect(await notices.peek(rig.thread.id)).toHaveLength(1);
    if (boundary !== "mid-run")
      expect((await rig.repos.threads.findById(rig.thread.id))?.initialPromptBakeId).toBeNull();
  });

  it("persists a drained message as a user turn the next iteration still sees", async () => {
    const { thread, inbox, requests, orchestrator, repos } = await setup({
      results: [toolCallResult("ask_user", "call-1"), textResult("done")],
    });
    const carried = await inbox.enqueue(message("carry me", thread.id));

    await execute(await orchestrator.prepare({ threadId: thread.id, userText: "hello" }));

    expect(requests).toHaveLength(2);
    expect(messageTexts(requests[0].messages)).toContain("carry me");
    // The message was acked at the end of iteration 1; iteration 2 only sees it
    // because it persisted as a user-role turn, not as a request-only render.
    expect(messageTexts(requests[1].messages)).toContain("carry me");

    const turns = await repos.turns.listByThread(thread.id);
    const messageTurn = turns.find((turn) => turn.id === carried.id);
    expect(messageTurn?.role).toBe("user");
    // A writer message is the writer's own turn, not a hidden inbox delivery.
    expect(messageTurn?.metadata).toBeNull();
    const blocks = await repos.blocks.listByTurn(messageTurn?.id as string);
    expect(blocks.some((block) => block.textContent === "carry me")).toBe(true);
    expect(await inbox.selectPending(thread.id)).toEqual([]);
  });
});

describe("drain-only start", () => {
  it("delivers a structured subagent update without exposing its execution id or saved report body", async () => {
    const rig = await setup();
    const { thread, repos, orchestrator, requests, delivery, deps } = rig;
    const callerTurn = await repos.turns.create({
      threadId: thread.id,
      role: "assistant",
      origin: "assistant",
      status: "complete",
      prevTurnId: null,
    });
    const child = await repos.threads.createSubagent({
      userId: thread.userId,
      projectId: thread.projectId,
      parentThreadId: thread.id,
      rootThreadId: thread.id,
      originTurnId: callerTurn.id,
      spawnDepth: 1,
    });
    const execution = await repos.turns.create({
      threadId: child.id,
      role: "assistant",
      origin: "assistant",
      status: "complete",
      prevTurnId: null,
    });
    await repos.executionReports.admit({
      childThreadId: child.id,
      executionTurnId: execution.id,
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
      executionTurnId: execution.id,
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
    const childHandle = child.ref;
    if (childHandle === null) throw new Error("Expected child ref");
    expect(await repos.turns.findById(queued.id)).toMatchObject({
      role: "system",
      metadata: childCompletionMetadata({
        handle: childHandle,
        outcome: "succeeded",
        execution: execution.id,
        childThreadId: child.id,
        agentName: child.agentName ?? "Subagent",
      }),
    });
    const blocks = await repos.blocks.listByTurn(queued.id);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ blockType: "text" });
    const notification = requests[0].messages.find(
      (message) =>
        message.role === "user" &&
        messageText(message).includes(`Subagent ${child.ref} finished (succeeded)`),
    );
    expect(messageText(notification as Message)).toContain(`thread_report({"ref":"${child.ref}"})`);
    expect(messageText(notification as Message)).not.toContain(execution.id);
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
    expect(turns.find((turn) => turn.id === first.id)?.createdAt).not.toBe(
      enqueuedAt.toISOString(),
    );
    expect(turns.find((turn) => turn.id === second.id)?.prevTurnId).toBe(first.id);
    expect(turns.find((turn) => turn.role === "assistant")?.prevTurnId).toBe(second.id);
    expect(await inbox.selectPending(thread.id)).toEqual([]);
  });
});
