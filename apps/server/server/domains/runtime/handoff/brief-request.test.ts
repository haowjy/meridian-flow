/** Branch preparation stays read-only and stops at the selected source turn. */

import type { JsonValue } from "@meridian/contracts/threads";
import { expect, it } from "vitest";
import type { ModelInfo, Tool } from "../gateway/index.js";
import { createRuntimeHarness } from "../loop/__tests__/runtime-harness.js";
import { scriptedSummarizer } from "../loop/__tests__/scripted-summarizer.js";
import { createInertGateway } from "../loop/__tests__/test-gateway.js";
import { generateHandoffBrief } from "./brief-request.js";

const model: ModelInfo = {
  id: "writer-model",
  provider: "writer-provider",
  tokenizer: "o200k",
  displayName: "Writer",
  contextWindow: 100_000,
  maxOutputTokens: 4_096,
  promptCache: { kind: "explicit", ttlMs: 60_000 },
  capabilities: new Set(),
};

const bakedTool: Tool = {
  type: "function",
  name: "chapter_read",
  description: "Read a chapter",
  inputSchema: { type: "object", properties: { uri: { type: "string" } } },
};

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Expected a value");
  return value;
}

async function prepareBrief(input: {
  userCutoff: boolean;
  previousTooLarge?: boolean;
  sourcePreparationFails?: boolean;
}) {
  let sourceId = "";
  const summarizer = scriptedSummarizer();
  const gateway = {
    ...createInertGateway(model.id),
    listModels: () => [model],
  };
  const rig = createRuntimeHarness({
    gateway,
    summarizer,
    boundThreads: () => [sourceId],
  });
  const source = await rig.repos.threads.create({ userId: "writer", projectId: "project" });
  sourceId = source.id;
  await rig.repos.threads.bakeInitialPrompt(source.id, {
    composedSystemPrompt: "Frozen source prompt",
    bakedTools: [bakedTool as unknown as JsonValue],
    bakedSkillSlugs: [],
    contentHash: "source-bake",
  });

  const first = await rig.repos.turns.create({
    threadId: source.id,
    role: "user",
    origin: "writer",
    status: "complete",
  });
  await rig.repos.blocks.create({
    turnId: first.id,
    blockType: "text",
    sequence: 0,
    content: "Earlier scene request.",
    textContent: "Earlier scene request.",
    status: "complete",
  });
  let cutoff = first;
  if (!input.userCutoff) {
    const answer = await rig.repos.turns.create({
      threadId: source.id,
      prevTurnId: first.id,
      role: "assistant",
      origin: "assistant",
      status: "complete",
    });
    await rig.repos.blocks.create({
      turnId: answer.id,
      blockType: "text",
      sequence: 0,
      content: "Earlier scene decision.",
      textContent: "Earlier scene decision.",
      status: "complete",
    });
    cutoff = answer;
  }
  if (input.userCutoff) {
    cutoff = await rig.repos.turns.create({
      threadId: source.id,
      prevTurnId: first.id,
      role: "user",
      origin: "writer",
      status: "complete",
    });
    await rig.repos.blocks.create({
      turnId: cutoff.id,
      blockType: "text",
      sequence: 0,
      content: "What should I do about the silver gate?",
      textContent: "What should I do about the silver gate?",
      status: "complete",
    });
  }
  const running = await rig.repos.turns.create({
    threadId: source.id,
    prevTurnId: cutoff.id,
    role: "assistant",
    origin: "assistant",
    status: "streaming",
  });
  await rig.repos.blocks.create({
    turnId: running.id,
    blockType: "text",
    sequence: 0,
    content: "This reply is beyond the selected cutoff.",
    textContent: "This reply is beyond the selected cutoff.",
    status: "partial",
  });
  const destination = await rig.repos.threads.create({
    userId: source.userId,
    projectId: source.projectId,
  });
  const priorSeed = input.previousTooLarge
    ? await rig.repos.turns.create({
        threadId: destination.id,
        role: "system",
        origin: "system",
        status: "error",
        metadata: {
          kind: "derivation_seed",
          derivation: "handoff",
          sourceThreadId: source.id,
          sourceRef: required(source.ref),
          sourceTitle: source.title,
          cutoffTurnId: cutoff.id,
          reason: "request_too_large",
          phase: "summary",
        },
      })
    : null;
  const seed = await rig.repos.turns.create({
    threadId: destination.id,
    ...(priorSeed ? { prevTurnId: priorSeed.id } : {}),
    role: "system",
    origin: "system",
    status: "pending",
    metadata: {
      kind: "derivation_seed",
      derivation: "handoff",
      sourceThreadId: source.id,
      sourceRef: required(source.ref),
      sourceTitle: source.title,
      cutoffTurnId: cutoff.id,
    },
  });
  if (input.sourcePreparationFails) {
    rig.deps.agentRevisions.readThreadBinding = async () => {
      throw new Error("Source binding unavailable");
    };
  }
  const beforeTurns = await rig.repos.turns.listByThread(source.id);
  const beforeBlocks = await rig.repos.blocks.listByThread(source.id);
  const result = await generateHandoffBrief(
    rig.deps,
    destination,
    seed,
    new AbortController().signal,
  );
  return { result, calls: summarizer.calls, beforeTurns, beforeBlocks, rig, source };
}

it.each([
  true,
  false,
])("prepares a source-shaped request through the selected turn (user cutoff=%s)", async (userCutoff) => {
  const { result, calls, beforeTurns, beforeBlocks, rig, source } = await prepareBrief({
    userCutoff,
  });
  const call = calls[0];
  const request = call?.requestInHand;

  expect(result.outcome.kind).toBe("complete");
  expect(call).toMatchObject({
    instruction: "handoff",
    source: { threadId: source.id },
  });
  expect(request?.model).toBe(model.id);
  expect(request?.tools).toEqual([bakedTool]);
  expect(JSON.stringify(request?.messages)).toContain(
    userCutoff ? "What should I do about the silver gate?" : "Earlier scene decision.",
  );
  expect(JSON.stringify(request?.messages)).not.toContain(
    "This reply is beyond the selected cutoff.",
  );
  expect(await rig.repos.turns.listByThread(source.id)).toEqual(beforeTurns);
  expect(await rig.repos.blocks.listByThread(source.id)).toEqual(beforeBlocks);
});

it("marks a retry after a too-large brief rejection as known too large", async () => {
  const { result, calls } = await prepareBrief({ userCutoff: false, previousTooLarge: true });
  expect(result.outcome.kind).toBe("complete");
  expect(calls[0]).toMatchObject({ knownTooLarge: true });
});

it("records no summary path when source preparation fails before a call", async () => {
  const { result, calls } = await prepareBrief({ userCutoff: false, sourcePreparationFails: true });

  expect(result.outcome).toMatchObject({ kind: "failed", modelResponses: [] });
  expect(result.outcome).not.toHaveProperty("summarizer");
  expect(result.failure).toEqual({ reason: "handoff_brief_failed", phase: "source_prepare" });
  expect(calls).toHaveLength(0);
});
