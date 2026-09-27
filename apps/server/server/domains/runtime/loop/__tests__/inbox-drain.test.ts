/** Loop-level inbox drain: batch delivery, request-only rendering, and the final-claim continuation. */

import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Turn } from "@meridian/contracts/threads";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryAccountSkillInstallStore } from "../../../packages/index.js";
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
import { NoPendingWakeError } from "../run-turn-port.js";
import { createTestAgentBinding } from "./runtime-fixtures.js";
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
      turn.role === "user" && (turn.metadata as { kind?: string } | null)?.kind === "inbox_message",
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
    supportsImageInput?: boolean;
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
    gateway: {
      ...gateway,
      listModels: () => [
        {
          id: "gpt-4.1-mini",
          provider: "openai",
          displayName: "Test model",
          contextWindow: 128_000,
          maxOutputTokens: 16_384,
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
    agentRevisions: createTestAgentBinding("gpt-4.1-mini", "", () => [thread.id]),
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

  it("persists a request-only notice as a durable system_update turn", async () => {
    const { thread, inbox, requests, orchestrator, repos } = await setup();
    await inbox.enqueue(notice("work context note", thread.id));

    await execute(await orchestrator.prepare({ threadId: thread.id, userText: "hello" }));

    const texts = messageTexts(requests[0].messages);
    expect(texts.some((text) => text.includes("work context note"))).toBe(true);
    // The run's own user + assistant turns, plus a durable notices turn so the
    // notice reproduces identically on a later request instead of vanishing.
    // A notice (like a Work refresh) splits the run: the original empty
    // assistant turn completes and a fresh one continues after the notice.
    const turns = await repos.turns.listByThread(thread.id);
    expect(turns).toHaveLength(4);
    const noticesTurn = turns.find(
      (turn) =>
        (turn.metadata as { kind?: string; section?: string } | null)?.section === "notices",
    );
    expect(noticesTurn).toMatchObject({
      role: "system",
      metadata: { kind: "system_update", section: "notices" },
    });
    expect(await inbox.selectPending(thread.id)).toEqual([]);
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
      (turn) =>
        (turn.metadata as { kind?: string; section?: string } | null)?.section === "skill_body",
    ) as Turn;
    expect(skillBodyTurn).toMatchObject({
      role: "system",
      prevTurnId: steerTurn.id,
      metadata: { kind: "system_update", section: "skill_body" },
    });
    const skillBodyBlocks = await repos.blocks.listByTurn(skillBodyTurn.id);
    expect(skillBodyBlocks).toHaveLength(1);
    expect(skillBodyBlocks[0]?.blockType).toBe("text");
    expect(skillBodyBlocks[0]?.textContent ?? "").toContain("skill invoked: writing-principles");
  });

  it.each([
    "available",
    "unavailable",
    "unsupported",
  ] as const)("projects a mid-run adopted message's references (%s) without replacing durable identities", async (availability) => {
    const documentId = "33333333-3333-4333-8333-333333333333";
    const uri = "uploads://@/gate-map.png";
    let adoptedTurnId: TurnId | undefined;
    const { thread, requests, orchestrator, repos, send } = await setup({
      supportsImageInput: availability !== "unsupported",
      imageAssets: {
        async resolve(scope, reference) {
          expect(scope).toEqual({
            threadId: thread.id,
            projectId: thread.projectId,
            actorUserId: USER_ID,
          });
          expect(reference).toEqual({
            type: "image_reference",
            documentId: "44444444-4444-4444-8444-444444444444",
            uri,
          });
          return availability === "available"
            ? { mediaType: "image/png", data: "aW1hZ2U=", sizeBytes: 5 }
            : null;
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
    const imageParts = requests[1].messages
      .flatMap((message) => message.content)
      .filter((part) => part.type !== "text");
    expect(imageParts).toEqual(
      availability === "available"
        ? [
            {
              type: "image",
              mediaType: "image/png",
              data: "aW1hZ2U=",
            },
          ]
        : [],
    );
    expect(texts).toContain("[[Gate Map]]");
    expect(texts).not.toContain("compare with [[Gate Map]]");
  });

  it("shares the image occurrence budget across history and adopted writer turns", async () => {
    const image = {
      type: "image" as const,
      documentId: "44444444-4444-4444-8444-444444444444",
      uri: "uploads://@/map.png",
    };
    const { thread, requests, orchestrator, repos, send } = await setup({
      imageAssets: {
        async resolve(_context, reference) {
          return {
            mediaType: "image/png",
            data: reference.uri,
            sizeBytes: 10 * 1024 * 1024,
          };
        },
      },
      onStream: async (call) => {
        if (call === 1)
          await send(thread.id, "new images", {
            blocks: [
              { type: "text", text: "new images" },
              { ...image, uri: "uploads://@/new.png" },
            ],
          });
      },
    });
    await send(thread.id, "old image", { blocks: [{ type: "text", text: "old image" }, image] });
    await execute(await orchestrator.prepare({ threadId: thread.id, drain: true }));
    expect(requests).toHaveLength(2);
    const users = requests[1].messages.filter((message) => message.role === "user");
    expect(
      users.map((message) => message.content.filter((part) => part.type === "image").length),
    ).toEqual([1, 1]);
    expect(messageTexts(users)).toEqual(["old image", "new images"]);
    const images = (await repos.blocks.listByThread(thread.id)).filter(
      (block) => block.blockType === "image",
    );
    const decisions = await repos.imageInclusions.findByThread(thread.id);
    expect(
      images.map((block) => decisions.find((decision) => decision.blockId === block.id)?.included),
    ).toEqual([true, true]);
    expect(users[0]?.content.find((part) => part.type === "image")).toMatchObject({
      data: image.uri,
    });
  });

  it("reuses image bytes unchanged in consecutive requests under budget", async () => {
    const image = {
      type: "image" as const,
      documentId: "44444444-4444-4444-8444-444444444444",
      uri: "uploads://@/stable.png",
    };
    const { thread, requests, orchestrator, send } = await setup({
      imageAssets: {
        async resolve() {
          return { mediaType: "image/png", data: "aW1hZ2U=", sizeBytes: 5 };
        },
      },
      onStream: async (call) => {
        if (call === 1)
          await send(thread.id, "follow-up", { blocks: [{ type: "text", text: "follow-up" }] });
      },
    });
    await send(thread.id, "image", { blocks: [{ type: "text", text: "image" }, image] });
    await execute(await orchestrator.prepare({ threadId: thread.id, drain: true }));

    const historyImage = (request: (typeof requests)[number]) => {
      const imagePart = request.messages
        .flatMap((message) => message.content)
        .find((part) => part.type === "image");
      return JSON.stringify(imagePart);
    };
    expect(requests).toHaveLength(2);
    expect(historyImage(required(requests[0]))).toBe(historyImage(required(requests[1])));
  });

  it("fails retryably on a transient image resolve error without deciding the image", async () => {
    const image = {
      type: "image" as const,
      documentId: "44444444-4444-4444-8444-000000000004",
      uri: "uploads://@/temporary-failure.png",
    };
    let resolutions = 0;
    const { thread, requests, orchestrator, repos, send, inbox } = await setup({
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
      turn: { status: "error", error: expect.stringContaining("temporary object-store timeout") },
    });
    expect(await repos.turns.findById(first.assistantTurnId)).toMatchObject({
      role: "assistant",
      status: "error",
      finishReason: "error",
    });
    expect(await repos.imageInclusions.findByThread(thread.id)).toEqual([]);
    expect(
      (await repos.turns.listByThread(thread.id)).filter(
        (turn) => (turn.metadata as { section?: string } | null)?.section === "image_inclusion",
      ),
    ).toHaveLength(0);
    expect(await inbox.selectPending(thread.id)).toEqual([]);

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

  it("fails mid-run preparation on the still-running assistant and acknowledges the steer", async () => {
    const original = {
      type: "image" as const,
      documentId: "44444444-4444-4444-8444-000000000004",
      uri: "uploads://@/original.png",
    };
    const steered = {
      type: "image" as const,
      documentId: "44444444-4444-4444-8444-000000000005",
      uri: "uploads://@/steered.png",
    };
    let resolutions = 0;
    const { thread, requests, orchestrator, repos, send, inbox } = await setup({
      results: [toolCallResult("unknown", "boundary-call")],
      imageAssets: {
        async resolve(_context, reference) {
          resolutions += 1;
          if (resolutions === 2)
            throw new ImageAssetResolutionError("temporary object-store timeout");
          return { mediaType: "image/png", data: reference.uri, sizeBytes: 5 };
        },
      },
      onStream: async (call) => {
        if (call === 1)
          await send(thread.id, "steer with image", {
            blocks: [{ type: "text", text: "steer with image" }, steered],
          });
      },
    });
    await send(thread.id, "start with image", {
      blocks: [{ type: "text", text: "start with image" }, original],
    });

    const run = await orchestrator.prepare({ threadId: thread.id, drain: true });
    await expect(run.execute()).resolves.toMatchObject({
      status: "error",
      turn: { status: "error", error: expect.stringContaining("temporary object-store timeout") },
    });

    expect(requests).toHaveLength(1);
    expect(await repos.turns.findById(run.assistantTurnId)).toMatchObject({
      role: "assistant",
      status: "error",
      finishReason: "error",
    });
    expect(await inbox.selectPending(thread.id)).toEqual([]);
  });

  it("names the loss of an image asset after its first inclusion", async () => {
    const image = {
      type: "image" as const,
      documentId: "44444444-4444-4444-8444-444444444444",
      uri: "uploads://@/disappeared.png",
    };
    let resolutions = 0;
    const { thread, requests, orchestrator, repos, send } = await setup({
      results: [
        toolCallResult("ask_user", "call-1"),
        toolCallResult("ask_user", "call-2"),
        textResult(),
      ],
      imageAssets: {
        async resolve() {
          resolutions += 1;
          return resolutions === 1
            ? { mediaType: "image/png", data: "aW1hZ2U=", sizeBytes: 5 }
            : null;
        },
      },
      onStream: async (call) => {
        if (call === 1)
          await send(thread.id, "follow-up", { blocks: [{ type: "text", text: "follow-up" }] });
      },
    });
    await send(thread.id, "image", { blocks: [{ type: "text", text: "image" }, image] });
    await execute(await orchestrator.prepare({ threadId: thread.id, drain: true }));

    expect(requests).toHaveLength(3);
    expect(
      requests[0]?.messages.flatMap((entry) => entry.content).some((part) => part.type === "image"),
    ).toBe(true);
    expect(
      requests[1]?.messages.flatMap((entry) => entry.content).some((part) => part.type === "image"),
    ).toBe(false);
    expect(
      messageTexts(required(requests[1]).messages).filter((text) =>
        text.includes("disappeared.png"),
      ),
    ).toHaveLength(1);
    expect(
      messageTexts(required(requests[2]).messages).filter((text) =>
        text.includes("disappeared.png"),
      ),
    ).toHaveLength(1);
    const imageBlock = (await repos.blocks.listByThread(thread.id)).find(
      (block) => block.blockType === "image",
    );
    expect(imageBlock).toBeDefined();
    expect(
      (await repos.imageInclusions.findByThread(thread.id)).find(
        (decision) => decision.blockId === imageBlock?.id,
      )?.included,
    ).toBe(false);
    expect(
      (await repos.turns.listByThread(thread.id)).filter(
        (turn) => (turn.metadata as { section?: string } | null)?.section === "image_inclusion",
      ),
    ).toHaveLength(1);
  });

  it("writes one durable system update when a new image evicts an older inclusion", async () => {
    const image = {
      type: "image" as const,
      documentId: "44444444-4444-4444-8444-444444444444",
      uri: "uploads://@/old.png",
    };
    const { thread, requests, orchestrator, repos, send } = await setup({
      results: [
        toolCallResult("ask_user", "call-1"),
        toolCallResult("ask_user", "call-2"),
        textResult(),
      ],
      imageAssets: {
        async resolve(_context, reference) {
          return {
            mediaType: "image/png",
            data: reference.uri,
            sizeBytes: 10 * 1024 * 1024,
          };
        },
      },
      onStream: async (call) => {
        if (call === 1) {
          await send(thread.id, "new images", {
            blocks: [
              { type: "text", text: "new images" },
              { ...image, uri: "uploads://@/new-1.png" },
              { ...image, uri: "uploads://@/new-2.png" },
            ],
          });
        }
      },
    });
    await send(thread.id, "old image", { blocks: [{ type: "text", text: "old image" }, image] });
    await execute(await orchestrator.prepare({ threadId: thread.id, drain: true }));

    expect(requests).toHaveLength(3);
    const updateText = (request: (typeof requests)[number]) =>
      messageTexts(request.messages).filter((text) => text.includes("Image context changed."));
    expect(updateText(required(requests[1]))).toHaveLength(1);
    expect(updateText(required(requests[2]))).toHaveLength(1);
    const turns = await repos.turns.listByThread(thread.id);
    const updates = turns.filter(
      (turn) => (turn.metadata as { section?: string } | null)?.section === "image_inclusion",
    );
    expect(updates).toHaveLength(1);
    expect((await repos.blocks.listByTurn(required(updates[0]).id))[0]?.textContent).toContain(
      "old.png",
    );
    const images = (await repos.blocks.listByThread(thread.id)).filter(
      (block) => block.blockType === "image",
    );
    const decisions = await repos.imageInclusions.findByThread(thread.id);
    expect(
      images.map((block) => decisions.find((decision) => decision.blockId === block.id)?.included),
    ).toEqual([false, true, true]);
  });

  it("keeps multi-turn history prefix-stable through tools, skill, image eviction, and inbox adoption", async () => {
    const image = (documentId: string, uri: string) => ({
      type: "image" as const,
      documentId,
      uri,
    });
    const originalImage = image(
      "44444444-4444-4444-8444-000000000001",
      "uploads://@/prefix-original.png",
    );
    const { thread, requests, orchestrator, repos, send } = await setup({
      results: [
        toolCallResult("unknown", "prefix-call-1"),
        toolCallResult("unknown", "prefix-call-2"),
        textResult("finished"),
        textResult("between runs"),
        toolCallResult("unknown", "run-start-eviction-call"),
        textResult("after run-start eviction"),
      ],
      skill: {
        slug: "writing-principles",
        name: "Writing Principles",
        description: "Craft rules for revision",
        body: "Show, do not tell.",
      },
      imageAssets: {
        async resolve(_context, reference) {
          return {
            mediaType: "image/png",
            data: reference.uri,
            sizeBytes: 10 * 1024 * 1024,
          };
        },
      },
      onStream: async (call) => {
        if (call === 2) {
          await send(thread.id, "follow-up with /skill", {
            activatedSkillSlugs: ["writing-principles"],
            blocks: [
              { type: "text", text: "follow-up with /skill" },
              image("44444444-4444-4444-8444-000000000002", "uploads://@/prefix-new-1.png"),
              image("44444444-4444-4444-8444-000000000003", "uploads://@/prefix-new-2.png"),
            ],
          });
        }
      },
    });
    await execute(
      await orchestrator.prepare({
        threadId: thread.id,
        userText: "first image with /skill",
        userBlocks: [{ type: "text", text: "first image with /skill" }, originalImage],
        activatedSkillSlugs: ["writing-principles"],
      }),
    );

    expect(requests).toHaveLength(3);
    const messageBytes = (request: (typeof requests)[number]) =>
      request.messages.map((message) => JSON.stringify(message));
    const startsWith = (history: string[], prefix: string[]) =>
      prefix.every((message, index) => history[index] === message);
    expect(
      startsWith(messageBytes(required(requests[1])), messageBytes(required(requests[0]))),
    ).toBe(true);

    // The named eviction may remove exactly the old image being evicted; every
    // other already-rendered message must remain byte-identical and in place.
    const beforeEviction = required(requests[1]).messages;
    const afterEviction = required(requests[2]).messages;
    expect(afterEviction.length).toBeGreaterThanOrEqual(beforeEviction.length);
    const changedExistingMessages: number[] = [];
    for (const [index, message] of beforeEviction.entries()) {
      const nextMessage = afterEviction[index];
      if (JSON.stringify(message) === JSON.stringify(nextMessage)) continue;

      const evictedParts = message.content.filter(
        (part) => part.type === "image" && part.data === originalImage.uri,
      );
      expect(evictedParts).toHaveLength(1);
      expect(nextMessage).toEqual({
        ...message,
        content: message.content.filter(
          (part) => !(part.type === "image" && part.data === originalImage.uri),
        ),
      });
      changedExistingMessages.push(index);
    }
    expect(changedExistingMessages).toHaveLength(1);
    const finalMessage = required(requests[2]).messages.find((message) =>
      messageText(message).includes("Image context changed."),
    );
    expect(finalMessage).toBeDefined();
    const finalPartsText = (finalMessage?.content ?? []).flatMap((part) =>
      part.type === "text" ? [part.text] : [],
    );
    const adoptedTextIndex = finalPartsText.findIndex((text) =>
      text.includes("follow-up with /skill"),
    );
    const adoptedSkillIndex = finalPartsText.findIndex((text) =>
      text.includes("skill invoked: writing-principles"),
    );
    const evictionIndex = finalPartsText.findIndex((text) =>
      text.includes("Image context changed."),
    );
    expect(adoptedTextIndex).toBeGreaterThanOrEqual(0);
    expect(adoptedSkillIndex).toBeGreaterThan(adoptedTextIndex);
    expect(evictionIndex).toBeGreaterThan(adoptedSkillIndex);

    const oldImageBlock = (await repos.blocks.listByThread(thread.id)).find((block) => {
      const content = block.content as { uri?: string } | null;
      return block.blockType === "image" && content?.uri === originalImage.uri;
    });
    const imageBreak = (await repos.turns.listByThread(thread.id)).find(
      (turn) => (turn.metadata as { section?: string } | null)?.section === "image_inclusion",
    );
    expect(imageBreak).toBeDefined();
    const adoptedSkillBody = (await repos.turns.listByThread(thread.id))
      .filter((turn) => (turn.metadata as { section?: string } | null)?.section === "skill_body")
      .at(-1);
    expect(imageBreak?.prevTurnId).toBe(adoptedSkillBody?.id);
    expect(
      (await repos.imageInclusions.findByThread(thread.id)).find(
        (decision) => decision.blockId === oldImageBlock?.id,
      )?.included,
    ).toBe(false);
    const nextAssistant = await repos.turns.findById(
      required(requests[2]).correlation?.turnId as TurnId,
    );
    expect(nextAssistant?.prevTurnId).toBe(imageBreak?.id);

    // A later run begins with the previous run's exact provider-visible history.
    await execute(await orchestrator.prepare({ threadId: thread.id, userText: "across runs" }));
    expect(requests).toHaveLength(4);
    expect(
      startsWith(messageBytes(required(requests[3])), messageBytes(required(requests[2]))),
    ).toBe(true);

    const previouslyIncluded = (await repos.imageInclusions.findByThread(thread.id)).filter(
      (decision) => decision.included,
    );
    await send(thread.id, "more image context", {
      blocks: [
        { type: "text", text: "more image context" },
        image("44444444-4444-4444-8444-000000000004", "uploads://@/prefix-run-start-1.png"),
        image("44444444-4444-4444-8444-000000000005", "uploads://@/prefix-run-start-2.png"),
      ],
    });
    await execute(await orchestrator.prepare({ threadId: thread.id, drain: true }));
    expect(requests).toHaveLength(6);
    const runStartRequest = required(requests[4]);
    const toolRoundRequest = required(requests[5]);
    expect(
      messageTexts(runStartRequest.messages).some((text) =>
        text.includes("Image context changed."),
      ),
    ).toBe(true);
    expect(
      (await repos.imageInclusions.findByThread(thread.id)).some(
        (decision) =>
          !decision.included &&
          previouslyIncluded.some((before) => before.blockId === decision.blockId),
      ),
    ).toBe(true);
    expect(startsWith(messageBytes(toolRoundRequest), messageBytes(runStartRequest))).toBe(true);
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
        turn.role === "user" &&
        (turn.metadata as { kind?: string } | null)?.kind === "inbox_message",
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

    // First run freezes the prompt by assigning the initial bake pointer, so the
    // second run's assembly reuses the stale thread loaded at run start instead
    // of refreshing it from the bake.
    await execute(await orchestrator.prepare({ threadId: thread.id, userText: "first" }));
    expect((await repos.threads.findById(thread.id))?.initialPromptBakeId).not.toBeNull();

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
    expect(writer).toBeDefined();
    expect(messageText(writer as Message)).toContain("steer body");
    expect(messageText(writer as Message)).toContain("work context note");
    expect(messageEntry).toBe(writer);
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
    expect(await repos.turns.findById(queued.id)).toMatchObject({
      role: "system",
      metadata: {
        kind: "subagent_update",
        handle: child.ref,
        outcome: "succeeded",
        execution: execution.id,
      },
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
    const turns = await repos.turns.listByThread(thread.id);
    const skillBodyTurn = turns.find(
      (turn) => (turn.metadata as { section?: string } | null)?.section === "skill_body",
    );
    expect(skillBodyTurn?.prevTurnId).toBe(sent.userTurnId);
    expect((await repos.turns.findById(fresh.id))?.prevTurnId).toBe(skillBodyTurn?.id);
    expect((await repos.turns.findById(run.assistantTurnId))?.prevTurnId).toBe(fresh.id);

    expect(requests).toHaveLength(1);
    const texts = messageTexts(requests[0]?.messages ?? []);
    expect(texts.some((text) => text.includes("skill invoked: writing-principles"))).toBe(true);
    expect(texts.some((text) => text.includes("Show, do not tell."))).toBe(true);
  });
});
