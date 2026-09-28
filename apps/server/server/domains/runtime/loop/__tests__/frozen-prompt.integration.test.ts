/** Provider-request contract: dynamic context and same-Agent derivation preserve prompt bytes. */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createBoundAgentCatalog,
  createInMemoryAccountSkillInstallStore,
  createInMemoryAgentRevisionStore,
} from "../../../packages/index.js";
import {
  createInMemoryProjectRepository,
  createInMemoryWorkRepository,
} from "../../../projects/index.js";
import { createInMemoryRepositories } from "../../../threads/adapters/in-memory/repositories.js";
import {
  CompactionMetadataCodec,
  decodeImageInclusionMetadata,
  forkThreadAgent,
  handoffThreadAgent,
  loadThreadConversationContext,
  rebindThreadWork,
  SubagentDerivationError,
  type ThreadAgentSwapDeps,
} from "../../../threads/index.js";
import type { Gateway, Message, ModelInfo, Tool } from "../../gateway/index.js";
import type { ImageAssetPort } from "../../ports/image-asset.js";
import { createReportPublisher } from "../../spawn/report-publisher.js";
import { createConversationSummarizer } from "../../summary/conversation-summarizer.js";
import { createWorkContextReader } from "../work-context.js";
import { createRuntimeHarness } from "./runtime-harness.js";
import { scriptedSummarizer } from "./scripted-summarizer.js";
import { scriptedGateway } from "./test-gateway.js";

function systemHash(messages: Message[]) {
  const system = messages.filter((message) => message.role === "system");
  expect(system).toHaveLength(1);
  const text = system[0].content.map((part) => (part.type === "text" ? part.text : "")).join("");
  return createHash("sha256").update(text).digest("hex");
}

async function fixture(
  onStream?: (call: number) => Promise<void>,
  threadId?: string,
  gatewayOverride?: ReturnType<typeof scriptedGateway> & Pick<Gateway, "listModels">,
  imageAssets?: ImageAssetPort,
) {
  const projects = createInMemoryProjectRepository();
  const works = createInMemoryWorkRepository();
  const repos = createInMemoryRepositories({
    projects,
    works,
    boundAgent: (id) => agentRevisions.boundAgent(id),
  });
  const agentRevisions = createInMemoryAgentRevisionStore({
    threadExists: async (id) => Boolean(await repos.threads.findById(id)),
  });
  const agentCatalog = createBoundAgentCatalog({
    store: agentRevisions,
    defaultModel: () => "gpt-4.1-mini",
    unavailableReasons: () => [],
  });
  const original = await agentCatalog.save("user-1", {
    slug: "writer",
    content: "---\nname: Writer\nmode: primary\n---\n\nOriginal writer.",
  });
  const project = await projects.create({ userId: "user-1", title: "Serial" });
  const noWork = await works.ensureNoWork(project.id);
  const thread = await repos.threads.create({
    id: threadId,
    userId: "user-1",
    projectId: project.id,
  });
  await repos.threadWorks.addMembership(thread.id, noWork.id, true);
  const binding = await agentCatalog.resolvePrimary(thread.userId, original.selection);
  if (!binding.ok) throw new Error("Fixture binding unavailable");
  await agentRevisions.bindThread(thread.id, binding.revision.id, binding.configuration, null);
  const gateway =
    gatewayOverride ??
    scriptedGateway({ onStream, usage: { inputTokens: 1000, outputTokens: 100 } });
  const workContext = createWorkContextReader({ ...repos, works });
  const accountSkillInstalls = createInMemoryAccountSkillInstallStore();
  const rig = createRuntimeHarness({
    repos,
    agentRevisions,
    gateway,
    workContext,
    accountSkillInstalls,
    ...(imageAssets ? { imageAssets } : {}),
  });
  await rig.creditLedger.grant({
    userId: thread.userId,
    source: "manual",
    amountMillicredits: "10000000",
    reason: "fixture",
  });
  const derive: ThreadAgentSwapDeps = {
    ...repos,
    projects,
    works,
    agentRevisions,
    agentCatalog,
    eventWriter: rig.deps.eventWriter,
    workContextNotices: rig.delivery,
  };
  async function run(threadId = thread.id, tools?: Tool[]) {
    const run = await rig.orchestrator.prepare({ threadId, userText: "Continue.", tools });
    const outcome = await run.execute();
    expect(outcome.status, JSON.stringify(outcome)).toBe("complete");
    return run;
  }
  return {
    ...rig,
    accountSkillInstalls,
    repos,
    thread,
    works,
    original,
    derive,
    run,
    requests: gateway.requests,
  };
}

describe("frozen prompt provider requests", () => {
  it("pins complete requests for a plain thread, fork, and fork cut at an inherited turn", async () => {
    let nextId = 1;
    vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(
      () =>
        `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}` as ReturnType<
          Crypto["randomUUID"]
        >,
    );
    const model: ModelInfo = {
      id: "gpt-4.1-mini",
      provider: "openai",
      tokenizer: "o200k" as const,
      displayName: "Fixture",
      contextWindow: 100_000,
      maxOutputTokens: 4_096,
      promptCache: { kind: "explicit", ttlMs: 60 * 60 * 1_000 },
      capabilities: new Set(),
    };
    const tools: Tool[] = [
      {
        type: "function",
        name: "search",
        description: "Search the story notes.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
      },
    ];
    const gateway = Object.assign(
      scriptedGateway({ usage: { inputTokens: 1000, outputTokens: 100 } }),
      { listModels: () => [model] },
    );
    try {
      // Use the exact same runtime path as production, with a cache-capable
      // model so the snapshot also captures canonical cacheBreakpoint marks.
      const rig = await fixture(undefined, "00000000-0000-4000-8000-000000000010", gateway);
      const plain = await rig.run(rig.thread.id, tools);
      const { thread: fork } = await forkThreadAgent(rig.derive, {
        id: "00000000-0000-4000-8000-000000000020",
        threadId: rig.thread.id,
        userId: rig.thread.userId,
        originTurnId: plain.executionTurnId,
      });
      await rig.run(fork.id, tools);
      const { thread: nestedFork } = await forkThreadAgent(rig.derive, {
        id: "00000000-0000-4000-8000-000000000030",
        threadId: fork.id,
        userId: fork.userId,
        originTurnId: plain.executionTurnId,
      });
      await rig.run(nestedFork.id, tools);

      expect(gateway.requests).toHaveLength(3);
      expect(gateway.requests[0]?.promptCacheKey).toBe(rig.thread.id);
      expect(gateway.requests[1]?.promptCacheKey).toBe(rig.thread.id);
      // The inherited cutoff is owned by the original source, not the first fork.
      expect(gateway.requests[2]?.promptCacheKey).toBe(rig.thread.id);
      expect(gateway.requests[0]?.tools).toEqual(tools);
      // Correlation is observability-only metadata, not provider request bytes;
      // storage IDs added by later implementation steps must not move this gate.
      const providerRequests = gateway.requests.map(
        ({ correlation: _correlation, signal: _signal, ...request }) => request,
      );
      expect(providerRequests).toMatchSnapshot();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("forks the latest image decision at the cutoff after the source loses its asset", async () => {
    const gateway = Object.assign(
      scriptedGateway({ usage: { inputTokens: 1000, outputTokens: 100 } }),
      {
        listModels: () => [
          {
            id: "gpt-4.1-mini",
            provider: "openai" as const,
            tokenizer: "o200k" as const,
            displayName: "Fixture",
            contextWindow: 100_000,
            maxOutputTokens: 4_096,
            promptCache: { kind: "none" as const, ttlMs: null },
            capabilities: new Set(["image_input" as const]),
          },
        ],
      },
    );
    let assetAvailable = true;
    const rig = await fixture(undefined, undefined, gateway, {
      async resolve() {
        return assetAvailable ? { mediaType: "image/png", data: "aW1hZ2U=", sizeBytes: 5 } : null;
      },
    });
    const image = {
      type: "image" as const,
      documentId: "44444444-4444-4444-8444-000000000101",
      uri: "uploads://@/asset-lost-before-fork.png",
    };

    await rig.send(rig.thread.id, "remember this image", {
      blocks: [{ type: "text", text: "remember this image" }, image],
    });
    const original = await rig.orchestrator.prepare({ threadId: rig.thread.id, drain: true });
    await original.execute();
    const originalImage = (await rig.repos.blocks.listByThread(rig.thread.id)).find(
      (block) => block.blockType === "image",
    );
    if (!originalImage) throw new Error("Missing original image block");
    expect(
      (await rig.repos.imageInclusions.findByThread(rig.thread.id)).find(
        (decision) => decision.blockId === originalImage.id,
      )?.included,
    ).toBe(true);

    assetAvailable = false;
    await rig.run(rig.thread.id);
    expect(
      (await rig.repos.imageInclusions.findByThread(rig.thread.id)).find(
        (decision) => decision.blockId === originalImage.id,
      )?.included,
    ).toBe(false);
    expect(
      (await rig.repos.turns.listByThread(rig.thread.id)).filter(
        (turn) => decodeImageInclusionMetadata(turn.metadata) !== null,
      ),
    ).toHaveLength(1);

    const { thread: fork } = await forkThreadAgent(rig.derive, {
      id: crypto.randomUUID(),
      threadId: rig.thread.id,
      userId: rig.thread.userId,
      originTurnId: original.executionTurnId,
    });
    expect(
      (await rig.repos.imageInclusions.findByThread(fork.id)).find(
        (decision) => decision.blockId === originalImage.id,
      ),
    ).toMatchObject({ included: true });
  });

  it("names a first-sight unavailable image and assigns its decision to the break turn", async () => {
    const gateway = Object.assign(
      scriptedGateway({ usage: { inputTokens: 1000, outputTokens: 100 } }),
      {
        listModels: () => [
          {
            id: "gpt-4.1-mini",
            provider: "openai" as const,
            tokenizer: "o200k" as const,
            displayName: "Fixture",
            contextWindow: 100_000,
            maxOutputTokens: 4_096,
            promptCache: { kind: "none" as const, ttlMs: null },
            capabilities: new Set(["image_input" as const]),
          },
        ],
      },
    );
    const rig = await fixture(undefined, undefined, gateway, {
      async resolve() {
        return null;
      },
    });
    const image = {
      type: "image" as const,
      documentId: "44444444-4444-4444-8444-000000000102",
      uri: "uploads://@/first-sight-loss.png",
    };
    await rig.send(rig.thread.id, "look at this image", {
      blocks: [{ type: "text", text: "look at this image" }, image],
    });

    const run = await rig.orchestrator.prepare({ threadId: rig.thread.id, drain: true });
    await expect(run.execute()).resolves.toMatchObject({ status: "complete" });

    const imageBlock = (await rig.repos.blocks.listByThread(rig.thread.id)).find(
      (block) => block.blockType === "image",
    );
    if (!imageBlock) throw new Error("Missing first-sight image block");
    const writerTurn = await rig.repos.turns.findById(imageBlock.turnId);
    const breakTurn = (await rig.repos.turns.listByThread(rig.thread.id)).find(
      (turn) => decodeImageInclusionMetadata(turn.metadata) !== null,
    );
    const imageMetadata = decodeImageInclusionMetadata(breakTurn?.metadata);
    expect(breakTurn).toMatchObject({
      prevTurnId: writerTurn?.id,
    });
    expect(imageMetadata?.breaks).toEqual([
      {
        blockId: imageBlock.id,
        uri: image.uri,
        reason: "asset_unavailable_first_sight",
      },
    ]);
    expect(
      (await rig.repos.imageInclusions.findByThread(rig.thread.id)).find(
        (decision) => decision.blockId === imageBlock.id,
      ),
    ).toMatchObject({ included: false, decisionTurnId: breakTurn?.id });

    const request = gateway.requests[0];
    expect(request).toBeDefined();
    const parts = request?.messages.flatMap((message) => message.content) ?? [];
    expect(parts.some((part) => part.type === "image")).toBe(false);
    expect(
      parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
    ).toContain(
      "The model could not include uploads://@/first-sight-loss.png because its asset is unavailable.",
    );
  });

  it("keeps a mid-run image-loss decision with its break notice across an assistant cutoff", async () => {
    let assetAvailable = true;
    const gateway = Object.assign(
      scriptedGateway({
        results: [
          {
            content: [
              { type: "tool_use", toolCallId: "missing-1", toolName: "missing", input: {} },
            ],
            toolCalls: [],
            finishReason: "tool_use",
            usage: { inputTokens: 1, outputTokens: 1 },
            model: "gpt-4.1-mini",
            provider: "openai",
          },
          {
            content: [{ type: "text", text: "continue after the image loss" }],
            toolCalls: [],
            finishReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
            model: "gpt-4.1-mini",
            provider: "openai",
          },
        ],
        onStream: async (call) => {
          if (call === 1) assetAvailable = false;
        },
      }),
      {
        listModels: () => [
          {
            id: "gpt-4.1-mini",
            provider: "openai" as const,
            tokenizer: "o200k" as const,
            displayName: "Fixture",
            contextWindow: 100_000,
            maxOutputTokens: 4_096,
            promptCache: { kind: "none" as const, ttlMs: null },
            capabilities: new Set(["image_input" as const]),
          },
        ],
      },
    );
    const rig = await fixture(undefined, undefined, gateway, {
      async resolve() {
        return assetAvailable ? { mediaType: "image/png", data: "aW1hZ2U=", sizeBytes: 5 } : null;
      },
    });
    const image = {
      type: "image" as const,
      documentId: "44444444-4444-4444-8444-000000000146",
      uri: "uploads://@/mid-run-loss.png",
    };
    await rig.send(rig.thread.id, "keep this image in mind", {
      blocks: [{ type: "text", text: "keep this image in mind" }, image],
    });

    const run = await rig.orchestrator.prepare({ threadId: rig.thread.id, drain: true });
    await expect(run.execute()).resolves.toMatchObject({ status: "complete" });

    const imageBlock = (await rig.repos.blocks.listByThread(rig.thread.id)).find(
      (block) => block.blockType === "image",
    );
    if (!imageBlock) throw new Error("Missing mid-run image block");
    const sourceDecision = (await rig.repos.imageInclusions.findByThread(rig.thread.id)).find(
      (decision) => decision.blockId === imageBlock.id,
    );
    const breakTurn = (await rig.repos.turns.listByThread(rig.thread.id)).find(
      (turn) => decodeImageInclusionMetadata(turn.metadata) !== null,
    );
    expect(breakTurn?.prevTurnId).toBe(run.executionTurnId);
    expect(sourceDecision).toMatchObject({ included: false, decisionTurnId: breakTurn?.id });

    const { thread: fork } = await forkThreadAgent(rig.derive, {
      id: crypto.randomUUID(),
      threadId: rig.thread.id,
      userId: rig.thread.userId,
      originTurnId: run.executionTurnId,
    });
    expect(
      (await rig.repos.imageInclusions.findByThread(fork.id)).find(
        (decision) => decision.blockId === imageBlock.id,
      ),
    ).toMatchObject({ included: true });

    assetAvailable = true;
    await rig.run(fork.id);
    const forkRequest = gateway.requests.at(-1);
    expect(
      forkRequest?.messages
        .flatMap((message) => message.content)
        .some((part) => part.type === "image"),
    ).toBe(true);
    expect(
      forkRequest?.messages
        .flatMap((message) => message.content)
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
    ).not.toContain("Image context changed.");
  });

  it("isolates image inclusion and eviction decisions between fork and source", async () => {
    const model: ModelInfo = {
      id: "gpt-4.1-mini",
      provider: "openai",
      tokenizer: "o200k" as const,
      displayName: "Fixture",
      contextWindow: 100_000,
      maxOutputTokens: 4_096,
      promptCache: { kind: "none", ttlMs: null },
      capabilities: new Set(["image_input"]),
    };
    const gateway = Object.assign(
      scriptedGateway({ usage: { inputTokens: 1000, outputTokens: 100 } }),
      { listModels: () => [model] },
    );
    const rig = await fixture(undefined, undefined, gateway, {
      async resolve(_context, reference) {
        return {
          mediaType: "image/png",
          data: reference.uri,
          sizeBytes: reference.uri.includes("large") ? 10 * 1024 * 1024 : 5,
        };
      },
    });
    let imageId = 1;
    function image(uri: string) {
      return {
        type: "image" as const,
        documentId: `44444444-4444-4444-8444-${String(imageId++).padStart(12, "0")}`,
        uri,
      };
    }
    async function sendAndRun(threadId: string, text: string, images: ReturnType<typeof image>[]) {
      await rig.send(threadId, text, {
        blocks: [{ type: "text", text }, ...images],
      });
      const run = await rig.orchestrator.prepare({ threadId, drain: true });
      await run.execute();
      return run;
    }
    const originalImage = image("uploads://@/original.png");
    const original = await sendAndRun(rig.thread.id, "original", [originalImage]);
    const originalImageBlock = (await rig.repos.blocks.listByThread(rig.thread.id)).find(
      (block) => block.blockType === "image",
    );
    expect(originalImageBlock).toBeDefined();
    expect(
      (await rig.repos.imageInclusions.findByThread(rig.thread.id)).find(
        (decision) => decision.blockId === originalImageBlock?.id,
      )?.included,
    ).toBe(true);
    const { thread: firstFork } = await forkThreadAgent(rig.derive, {
      id: crypto.randomUUID(),
      threadId: rig.thread.id,
      userId: rig.thread.userId,
      originTurnId: original.executionTurnId,
    });
    const { thread: secondFork } = await forkThreadAgent(rig.derive, {
      id: crypto.randomUUID(),
      threadId: rig.thread.id,
      userId: rig.thread.userId,
      originTurnId: original.executionTurnId,
    });

    await sendAndRun(rig.thread.id, "source eviction", [
      image("uploads://@/source-large-1.png"),
      image("uploads://@/source-large-2.png"),
    ]);
    const sourceImages = (await rig.repos.blocks.listByThread(rig.thread.id)).filter(
      (block) => block.blockType === "image",
    );
    const sourceDecisions = await rig.repos.imageInclusions.findByThread(rig.thread.id);
    expect(
      sourceDecisions.find((decision) => decision.blockId === sourceImages[0]?.id)?.included,
    ).toBe(false);
    expect(
      (await rig.repos.turns.listByThread(rig.thread.id)).filter(
        (turn) => decodeImageInclusionMetadata(turn.metadata) !== null,
      ),
    ).toHaveLength(1);

    const forkAfterSourceEviction = await forkThreadAgent(rig.derive, {
      id: crypto.randomUUID(),
      threadId: rig.thread.id,
      userId: rig.thread.userId,
      originTurnId: original.executionTurnId,
    });
    await sendAndRun(forkAfterSourceEviction.thread.id, "cutoff still includes image", []);
    expect(
      (await rig.repos.imageInclusions.findByThread(forkAfterSourceEviction.thread.id)).find(
        (decision) => decision.blockId === originalImageBlock?.id,
      ),
    ).toMatchObject({ included: true, decisionTurnId: expect.any(String) });
    expect(
      gateway.requests
        .at(-1)
        ?.messages.flatMap((message) => message.content)
        .some((part) => part.type === "image"),
    ).toBe(true);

    await sendAndRun(firstFork.id, "first fork retains source image", []);
    expect(
      (await rig.repos.imageInclusions.findByThread(firstFork.id)).find(
        (decision) => decision.blockId === originalImageBlock?.id,
      )?.included,
    ).toBe(true);
    const firstForkRequest = gateway.requests.at(-1);
    expect(
      firstForkRequest?.messages
        .flatMap((message) => message.content)
        .some((part) => part.type === "image"),
    ).toBe(true);
    expect(
      firstForkRequest?.messages
        .flatMap((message) => message.content)
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n"),
    ).not.toContain("Image context changed.");

    await sendAndRun(firstFork.id, "first fork eviction", [
      image("uploads://@/fork-large-1.png"),
      image("uploads://@/fork-large-2.png"),
    ]);
    const firstForkDecisions = await rig.repos.imageInclusions.findByThread(firstFork.id);
    expect(
      firstForkDecisions.find((decision) => decision.blockId === originalImageBlock?.id)?.included,
    ).toBe(false);
    expect(
      (await rig.repos.turns.listByThread(firstFork.id)).filter(
        (turn) => decodeImageInclusionMetadata(turn.metadata) !== null,
      ),
    ).toHaveLength(1);

    expect(
      (await rig.repos.imageInclusions.findByThread(secondFork.id)).find(
        (decision) => decision.blockId === originalImageBlock?.id,
      )?.included,
    ).toBe(true);
    expect(
      (await rig.repos.turns.listByThread(secondFork.id)).filter(
        (turn) => decodeImageInclusionMetadata(turn.metadata) !== null,
      ),
    ).toHaveLength(0);
    expect(
      (await rig.repos.imageInclusions.findByThread(rig.thread.id)).find(
        (decision) => decision.blockId === sourceImages[0]?.id,
      )?.included,
    ).toBe(false);

    const reverseImage = image("uploads://@/reverse-source.png");
    const reverseSourceRun = await sendAndRun(rig.thread.id, "fresh source image", [reverseImage]);
    const reverseImageBlock = (await rig.repos.blocks.listByThread(rig.thread.id)).find((block) => {
      const content = block.content as { uri?: string } | null;
      return block.blockType === "image" && content?.uri === reverseImage.uri;
    });
    if (!reverseImageBlock) throw new Error("Missing reverse-direction source image block");
    const reverseFork = await forkThreadAgent(rig.derive, {
      id: crypto.randomUUID(),
      threadId: rig.thread.id,
      userId: rig.thread.userId,
      originTurnId: reverseSourceRun.executionTurnId,
    });
    await sendAndRun(reverseFork.thread.id, "fork evicts image", [
      image("uploads://@/reverse-fork-large-1.png"),
      image("uploads://@/reverse-fork-large-2.png"),
    ]);
    expect(
      (await rig.repos.imageInclusions.findByThread(reverseFork.thread.id)).find(
        (decision) => decision.blockId === reverseImageBlock.id,
      )?.included,
    ).toBe(false);
    expect(
      (await rig.repos.imageInclusions.findByThread(rig.thread.id)).find(
        (decision) => decision.blockId === reverseImageBlock.id,
      )?.included,
    ).toBe(true);
  });

  it("keeps one hash through steer, child notice, request-only notice, skill and Work switch across runs", async () => {
    const rig = await fixture(async (call) => {
      if (call === 1) {
        await rig.send(rig.thread.id, "Tighten the dialogue.", { activatedSkillSlugs: ["craft"] });
        await rig.delivery.enqueue({
          threadId: rig.thread.id,
          intent: "notice",
          provenance: { kind: "system", source: "probe" },
          body: { kind: "text", text: "Request-only reminder." },
          idempotencyKey: "reminder",
        });
      }
    });
    await rig.accountSkillInstalls.insert({
      ownerUserId: rig.thread.userId,
      slug: "craft",
      name: "Craft",
      description: "Dialogue craft",
      body: "Use distinctive dialogue.",
    });
    const first = await rig.run();
    expect(rig.requests).toHaveLength(2);
    const child = await rig.repos.threads.createSubagent({
      userId: rig.thread.userId,
      projectId: rig.thread.projectId,
      parentThreadId: rig.thread.id,
      rootThreadId: rig.thread.id,
      originTurnId: first.executionTurnId,
      spawnDepth: 1,
    });
    const execution = await rig.repos.turns.create({
      threadId: child.id,
      role: "assistant",
      origin: "assistant",
      status: "complete",
    });
    await rig.repos.executionReports.admit({
      childThreadId: child.id,
      executionTurnId: execution.id,
      handle: child.ref ?? "",
      origin: "spawn",
      deliveryMode: "background_notification",
      callerThreadId: rig.thread.id,
      callerTurnId: first.executionTurnId,
      toolCallId: "spawn-1",
      cardBlockId: null,
    });
    await rig.repos.executionReports.finalizeOnce({
      childThreadId: child.id,
      executionTurnId: execution.id,
      outcome: "succeeded",
      reason: null,
      source: "return_result",
      summary: "Private report body",
    });
    await createReportPublisher({
      repos: rig.repos,
      eventWriter: rig.deps.eventWriter,
      eventSink: rig.deps.eventSink,
      delivery: rig.delivery,
    }).publish(child.id, execution.id);
    const work = await rig.works.create({ projectId: rig.thread.projectId, name: "Revision" });
    await rebindThreadWork(
      {
        ...rig.repos,
        works: rig.works,
        workContextNotices: rig.delivery,
      },
      { threadId: rig.thread.id, workId: work.id },
    );
    await rig.run();
    await rig.run();
    expect(rig.requests).toHaveLength(4);
    const rendered = rig.requests.map((request) => JSON.stringify(request.messages));
    expect(rendered[1]).toContain("Request-only reminder.");
    expect(rendered[1]).toContain("Use distinctive dialogue.");
    expect(rendered[2]).toContain(`Subagent ${child.ref} finished`);
    expect(rendered[2]).toContain("Revision");
    expect(rendered[2]).not.toContain("Private report body");
    expect(new Set(rig.requests.map((request) => systemHash(request.messages))).size).toBe(1);
  });

  it("keeps the source Agent and frozen prompt on forks and same-Agent handoff", async () => {
    const rig = await fixture();
    await rig.run();
    const parent = await rig.repos.threads.findById(rig.thread.id);
    // The source's current Work differs from the Work captured by its first bake.
    const work = await rig.works.create({ projectId: rig.thread.projectId, name: "Later Work" });
    await rig.repos.threadWorks.rebindPrimary(rig.thread.id, work.id);
    await rig.derive.agentCatalog.save(rig.thread.userId, {
      slug: "writer",
      content: "---\nname: Writer\nmode: primary\n---\n\nAdvanced writer.",
      expectedRevisionId: rig.original.selection.definitionRevisionId,
    });
    for (let index = 0; index < 2; index += 1) {
      const { thread: fork } = await forkThreadAgent(rig.derive, {
        id: crypto.randomUUID(),
        threadId: rig.thread.id,
        userId: rig.thread.userId,
      });
      expect(fork.initialPromptBakeId).toBe(parent?.initialPromptBakeId);
      expect(fork.agentDefinitionRevisionId).toBe(rig.original.selection.definitionRevisionId);
      expect(fork.agentName).toBe("Writer");
      await rig.run(fork.id);
      const request = rig.requests[rig.requests.length - 1];
      expect(
        request.messages.some(
          (message) =>
            message.role === "user" &&
            message.content.some(
              (part) =>
                part.type === "text" && part.text.includes('current: later-work: "Later Work"'),
            ),
        ),
      ).toBe(true);
      expect(systemHash(request.messages)).toBe(systemHash(rig.requests[0].messages));
      expect(
        request.messages.some(
          (message) =>
            message.role === "user" &&
            JSON.stringify(message.content).includes("<system_update>") &&
            JSON.stringify(message.content).includes("Forked conversation"),
        ),
      ).toBe(true);
    }
    const { thread: handoff } = await handoffThreadAgent(
      { ...rig.derive, delivery: rig.delivery },
      {
        id: crypto.randomUUID(),
        originTurnId: (await rig.repos.turns.getLatestByThread(rig.thread.id))!.id,
        threadId: rig.thread.id,
        userId: rig.thread.userId,
        agentSelection: rig.original.selection,
      },
    );
    expect(handoff.initialPromptBakeId).toBe(parent?.initialPromptBakeId);
    await rig.run(handoff.id);
    const request = rig.requests[rig.requests.length - 1];
    expect(
      request.messages.some(
        (message) =>
          message.role === "user" &&
          message.content.some(
            (part) =>
              part.type === "text" && part.text.includes('current: later-work: "Later Work"'),
          ),
      ),
    ).toBe(true);
    expect(systemHash(request.messages)).toBe(systemHash(rig.requests[0].messages));
    expect(
      request.messages.some(
        (message) =>
          message.role === "user" && JSON.stringify(message.content).includes("Earlier context."),
      ),
    ).toBe(true);
  });

  it("C7b falls back cold when only source preview fails", async () => {
    const rig = await fixture();
    await rig.run();
    const cutoff = await rig.repos.turns.getLatestByThread(rig.thread.id);
    if (!cutoff) throw new Error("missing cutoff");
    const { thread } = await handoffThreadAgent(
      { ...rig.derive, delivery: rig.delivery },
      {
        id: crypto.randomUUID(),
        threadId: rig.thread.id,
        userId: rig.thread.userId,
        originTurnId: cutoff.id,
        agentSelection: rig.original.selection,
      },
    );
    const read = rig.deps.agentRevisions.readThreadBinding.bind(rig.deps.agentRevisions);
    rig.deps.agentRevisions.readThreadBinding = async (id) => {
      if (id === rig.thread.id) throw new Error("source binding unavailable");
      return read(id);
    };
    const summarizer = scriptedSummarizer();
    rig.deps.summarizer = summarizer;
    await (await rig.orchestrator.prepare({ threadId: thread.id, drain: true })).execute();
    expect(summarizer.calls).toHaveLength(1);
    expect(summarizer.calls[0].requestInHand).toBeNull();
    expect((await rig.repos.turns.listByThread(thread.id))[0].status).toBe("complete");
  });

  it("C7b preserves a skill activation ahead of Retry until the reply", async () => {
    const rig = await fixture();
    await rig.run();
    const cutoff = await rig.repos.turns.getLatestByThread(rig.thread.id);
    if (!cutoff) throw new Error("missing cutoff");
    await rig.accountSkillInstalls.insert({
      ownerUserId: rig.thread.userId,
      slug: "craft",
      name: "Craft",
      description: "Craft.",
      body: "Preserve the jade gate rhythm.",
    });
    const { thread } = await handoffThreadAgent(
      { ...rig.derive, delivery: rig.delivery },
      {
        id: crypto.randomUUID(),
        threadId: rig.thread.id,
        userId: rig.thread.userId,
        originTurnId: cutoff.id,
        agentSelection: rig.original.selection,
      },
    );
    rig.deps.summarizer = scriptedSummarizer(async (_, call) =>
      call === 1
        ? { kind: "failed", error: new Error("failed"), modelResponses: [] }
        : { kind: "complete", text: "Recovered brief", model: "summary-model", modelResponses: [] },
    );
    await (await rig.orchestrator.prepare({ threadId: thread.id, drain: true })).execute();
    await rig.send(thread.id, "Use craft", { activatedSkillSlugs: ["craft"] });
    await rig.delivery.enqueueControl({
      id: crypto.randomUUID(),
      threadId: thread.id,
      actorId: thread.userId,
      control: { kind: "handoff_brief" },
    });
    await rig.send(thread.id, "And continue");
    await (await rig.orchestrator.prepare({ threadId: thread.id, drain: true })).execute();
    expect(JSON.stringify(rig.requests.at(-1))).toContain("Preserve the jade gate rhythm.");
  });

  it("C7b a preview-only image loss runs cold without writing source decisions or turns", async () => {
    const gateway = Object.assign(
      scriptedGateway({ usage: { inputTokens: 1000, outputTokens: 100 } }),
      {
        listModels: () => [
          {
            id: "gpt-4.1-mini",
            provider: "openai",
            tokenizer: "o200k" as const,
            displayName: "Fixture",
            contextWindow: 100000,
            maxOutputTokens: 4096,
            promptCache: { kind: "automatic" as const, ttlMs: 60000 },
            capabilities: new Set(["image_input" as const]),
          },
        ],
      },
    );
    let available = true;
    const rig = await fixture(undefined, undefined, gateway, {
      async resolve() {
        return available ? { mediaType: "image/png", data: "aW1hZ2U=", sizeBytes: 5 } : null;
      },
    });
    await rig.send(rig.thread.id, "remember the map", {
      blocks: [
        { type: "text", text: "remember the map" },
        {
          type: "image",
          documentId: "44444444-4444-4444-8444-000000000101",
          uri: "uploads://@/map.png",
        },
      ],
    });
    await (await rig.orchestrator.prepare({ threadId: rig.thread.id, drain: true })).execute();
    const turns = await rig.repos.turns.listByThread(rig.thread.id);
    const decisions = await rig.repos.imageInclusions.findByThread(rig.thread.id);
    const cutoff = turns.at(-1)!;
    const { thread } = await handoffThreadAgent(
      { ...rig.derive, delivery: rig.delivery },
      {
        id: crypto.randomUUID(),
        threadId: rig.thread.id,
        userId: rig.thread.userId,
        originTurnId: cutoff.id,
        agentSelection: rig.original.selection,
      },
    );
    available = false;
    const summarizer = scriptedSummarizer();
    rig.deps.summarizer = summarizer;
    await (await rig.orchestrator.prepare({ threadId: thread.id, drain: true })).execute();
    expect(summarizer.calls).toHaveLength(1);
    expect(summarizer.calls[0].requestInHand).toBeNull();
    expect(await rig.repos.turns.listByThread(rig.thread.id)).toEqual(turns);
    expect(await rig.repos.imageInclusions.findByThread(rig.thread.id)).toEqual(decisions);
  });

  it("C7b previews exactly the source request and settles brief rows without parsing compaction metadata", async () => {
    const gateway = Object.assign(
      scriptedGateway({ usage: { inputTokens: 1000, outputTokens: 100 } }),
      {
        listModels: () => [
          {
            id: "gpt-4.1-mini",
            provider: "openai",
            tokenizer: "o200k" as const,
            displayName: "Fixture",
            contextWindow: 100000,
            maxOutputTokens: 4096,
            promptCache: { kind: "explicit" as const, ttlMs: 60000 },
            capabilities: new Set<never>(),
          },
        ],
      },
    );
    const rig = await fixture(undefined, undefined, gateway);
    await rig.run(rig.thread.id, [
      { type: "function", name: "search", description: "Search", inputSchema: {} },
    ]);
    const sourceRequest = rig.requests[0];
    const cutoff = await rig.repos.turns.getLatestByThread(rig.thread.id);
    if (!cutoff) throw new Error("missing cutoff");
    const source = await rig.repos.threads.findById(rig.thread.id);
    if (!source) throw new Error("missing source");
    const history = await loadThreadConversationContext(rig.repos, source);
    const { thread } = await handoffThreadAgent(
      { ...rig.derive, delivery: rig.delivery },
      {
        id: crypto.randomUUID(),
        threadId: source.id,
        userId: source.userId,
        originTurnId: cutoff.id,
        agentSelection: rig.original.selection,
      },
    );
    const seed = (await rig.repos.turns.listByThread(thread.id))[0];
    rig.deps.summarizer = createConversationSummarizer({
      gateway,
      agentRevisions: rig.deps.agentRevisions,
      prefixCacheStateFor: async () => ({ state: "warm", reason: "reusable_prefix" }),
      config: { model: "gpt-4.1-mini", maxOutputTokens: 100 },
    });
    const parse = vi.spyOn(CompactionMetadataCodec, "parse");
    try {
      await (await rig.orchestrator.prepare({ threadId: thread.id, drain: true })).execute();
      const briefRequest = rig.requests[1];
      expect(briefRequest.messages.slice(0, -2)).toEqual(sourceRequest.messages);
      expect(briefRequest.messages.at(-2)).toMatchObject({ role: "assistant" });
      expect(
        briefRequest.messages
          .at(-2)
          ?.content.filter((p) => p.type === "text")
          .map((p) => p.text)
          .join(""),
      ).toBe(
        history.blocks
          .filter((b) => b.turnId === cutoff.id && b.blockType === "text")
          .map((b) => b.textContent)
          .join(""),
      );
      expect(briefRequest.messages.at(-1)).toMatchObject({
        role: "user",
        content: [{ type: "text", text: expect.stringContaining("Writer, the incoming Agent") }],
      });
      expect(briefRequest.tools).toEqual(sourceRequest.tools);
      expect(briefRequest.promptCacheKey).toBe(sourceRequest.promptCacheKey);
      expect(briefRequest.correlation).toMatchObject({ threadId: thread.id, turnId: seed.id });
      expect(await rig.repos.modelResponses.listByTurn(seed.id)).toHaveLength(1);
      expect(parse).not.toHaveBeenCalled();
      expect(await rig.repos.turns.listByThread(source.id)).toEqual(history.turns);
      expect(await rig.repos.blocks.listByThread(source.id)).toEqual(history.blocks);
    } finally {
      parse.mockRestore();
    }
  });

  it.each([
    false,
    true,
  ])("C7b settles paid Stop rows without overwriting an expired=%s seed", async (expired) => {
    const rig = await fixture();
    await rig.run();
    const cutoff = await rig.repos.turns.getLatestByThread(rig.thread.id);
    if (!cutoff) throw new Error("missing cutoff");
    const { thread } = await handoffThreadAgent(
      { ...rig.derive, delivery: rig.delivery },
      {
        id: crypto.randomUUID(),
        threadId: rig.thread.id,
        userId: rig.thread.userId,
        originTurnId: cutoff.id,
        agentSelection: rig.original.selection,
      },
    );
    const seed = (await rig.repos.turns.listByThread(thread.id))[0];
    const responseId = crypto.randomUUID();
    rig.deps.summarizer = scriptedSummarizer(async () => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + (expired ? 60000 : 0));
      const stopped = await rig.orchestrator.cancel(thread.id, seed.id);
      clock.mockRestore();
      expect(stopped).toBe("cancelled");
      return {
        kind: "complete",
        text: "stale brief must not win",
        model: "gpt-4.1-mini",
        summarizer: { path: "warm", segments: 1 },
        modelResponses: [
          {
            id: responseId,
            turnId: seed.id,
            sequence: 0,
            provider: "openai",
            model: "gpt-4.1-mini",
            inputTokens: 100,
            outputTokens: 20,
            priceSource: "unknown",
            finishReason: "end_turn",
            requestMessageCount: 4,
            predictedCacheState: "warm",
            predictedCacheReason: "reusable_prefix",
          },
        ],
      };
    });
    await rig.send(thread.id, "hi after expired Stop");
    const run = await rig.orchestrator.prepare({ threadId: thread.id, drain: true });
    expect((await run.execute()).status).toBe("cancelled");
    await expect.poll(() => JSON.stringify(rig.requests.at(-1))).toContain("hi after expired Stop");
    expect((await rig.repos.turns.findById(seed.id))?.status).toBe("cancelled");
    const context = JSON.stringify(rig.requests.at(-1));
    expect(context).toContain("No brief is available.");
    expect(context).not.toContain("stale brief must not win");
    const rows = await rig.repos.modelResponses.listByTurn(seed.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(responseId);
    expect(Number(rows[0].costUsd)).toBeGreaterThan(0);
    if (expired)
      expect((await rig.repos.turns.findById(seed.id))?.metadata).not.toHaveProperty("summarizer");
  });

  it("starts a different-Agent handoff without carrying the source bake", async () => {
    const rig = await fixture();
    await rig.run();
    const nextAgent = await rig.derive.agentCatalog.save(rig.thread.userId, {
      slug: "new-writer",
      content: "---\nname: New Writer\nmode: primary\n---\n\nNew writer prompt.",
    });
    const { thread: handoff } = await handoffThreadAgent(
      { ...rig.derive, delivery: rig.delivery },
      {
        id: crypto.randomUUID(),
        originTurnId: (await rig.repos.turns.getLatestByThread(rig.thread.id))!.id,
        threadId: rig.thread.id,
        userId: rig.thread.userId,
        agentSelection: nextAgent.selection,
      },
    );
    expect(handoff.agentDefinitionRevisionId).toBe(nextAgent.selection.definitionRevisionId);
    expect(handoff.initialPromptBakeId).toBeNull();
  });

  it("refuses forking or handing off a subagent thread", async () => {
    const rig = await fixture();
    const agent = await rig.derive.agentCatalog.save(rig.thread.userId, {
      slug: "helper",
      content: "---\nname: Helper\nmode: subagent\n---\n\nHelper.",
    });
    const parentTurn = await rig.repos.turns.create({
      threadId: rig.thread.id,
      role: "assistant",
      origin: "assistant",
      status: "complete",
    });
    const child = await rig.repos.threads.createSubagent({
      userId: rig.thread.userId,
      projectId: rig.thread.projectId,
      parentThreadId: rig.thread.id,
      rootThreadId: rig.thread.id,
      originTurnId: parentTurn.id,
      spawnDepth: 1,
    });
    await rig.derive.agentRevisions.bindThread(
      child.id,
      agent.selection.definitionRevisionId,
      {
        model: "gpt-4.1-mini",
        skills: { load: [], available: [] },
        namedTargets: [],
      },
      null,
    );
    await expect(
      forkThreadAgent(rig.derive, {
        id: crypto.randomUUID(),
        threadId: child.id,
        userId: child.userId,
      }),
    ).rejects.toBeInstanceOf(SubagentDerivationError);
    await expect(
      handoffThreadAgent(
        { ...rig.derive, delivery: rig.delivery },
        {
          id: crypto.randomUUID(),
          originTurnId: parentTurn.id,
          threadId: child.id,
          userId: child.userId,
          agentSelection: rig.original.selection,
        },
      ),
    ).rejects.toBeInstanceOf(SubagentDerivationError);
  });

  it("leaves a default fork unfrozen when its parent has not made a request", async () => {
    const rig = await fixture();
    await rig.repos.turns.create({
      threadId: rig.thread.id,
      role: "user",
      origin: "writer",
      status: "complete",
    });
    const { thread: fork } = await forkThreadAgent(rig.derive, {
      id: crypto.randomUUID(),
      threadId: rig.thread.id,
      userId: rig.thread.userId,
    });
    expect(fork.initialPromptBakeId).toBeNull();
    await rig.run(fork.id);
    const rebaked = await rig.repos.threads.findById(fork.id);
    expect(rebaked?.initialPromptBakeId).not.toBeNull();
    const untouchedParent = await rig.repos.threads.findById(rig.thread.id);
    expect(untouchedParent?.initialPromptBakeId).toBeNull();
  });
});
