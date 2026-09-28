/** Compaction's two commits exercise real inbox, lease, epoch, and journal transactions. */
import { createDefaultTreeBudget } from "@meridian/contracts/spawn";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { executionScenario } from "../../../test-support/execution-scenario.js";
import type { NoticePort } from "../../notices/index.js";
import { createInMemoryEventSink } from "../../observability/index.js";
import { decodeImageInclusionMetadata, encodeImageInclusionMetadata } from "../../threads/index.js";
import { ImageAssetResolutionError } from "../ports/image-asset.js";
import { createConversationSummarizer } from "../summary/conversation-summarizer.js";
import { createTestAgentBinding } from "./__tests__/runtime-fixtures.js";
import { createRuntimeHarness } from "./__tests__/runtime-harness.js";
import { scriptedSummarizer } from "./__tests__/scripted-summarizer.js";
import { createTestDrizzleDelivery } from "./__tests__/test-drizzle-delivery.js";
import { scriptedGateway } from "./__tests__/test-gateway.js";
import { estimateRequestTokens } from "./compaction/estimate.js";
import { createOrchestrator } from "./orchestrator.js";
import { createPrefixCacheStateService } from "./prefix-cache-state.js";
import { assembleNextTurnContext } from "./turn-context-assembly.js";

function promptBytes(request: import("../gateway/index.js").GenerateRequest) {
  return JSON.stringify({
    messages: request.messages,
    tools: request.tools,
    promptCacheKey: request.promptCacheKey,
  });
}

function expectStablePrefix(
  previous: import("../gateway/index.js").GenerateRequest,
  next: import("../gateway/index.js").GenerateRequest,
) {
  expect(next.tools).toEqual(previous.tools);
  expect(next.promptCacheKey).toBe(previous.promptCacheKey);
  // Adjacent writer messages may merge into the previous final user message.
  expect(JSON.stringify(next.messages.slice(0, previous.messages.length - 1))).toBe(
    JSON.stringify(previous.messages.slice(0, -1)),
  );
}

const url = process.env.DATABASE_URL;
if (!url || !["1", "true"].includes(process.env.RUN_DB_TESTS ?? ""))
  describe.skip("compaction protocol", () => {});
else
  describe("compaction protocol", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { truncateDrizzleTables } = await import("../../../test-support/drizzle-reset.js");
    const { createDrizzleEventJournalWriter } = await import("../../threads/index.js");
    const { createDrizzleNoticePort } = await import(
      "../../notices/adapters/drizzle-notice-port.js"
    );
    const { createDrizzleRunClaim } = await import("../adapters/drizzle-run-claim.js");
    assertThrowawayDatabaseForRunDbTests(url);
    const db = createDb(url, { max: 8 });
    beforeEach(() => truncateDrizzleTables(db, [schema.users]));
    afterAll(() => db.close());

    async function fixture(
      options: {
        notices?: NoticePort;
        history?: string;
        child?: boolean;
        summarizer?: ReturnType<typeof scriptedSummarizer>;
        gateway?: ReturnType<typeof scriptedGateway>;
      } = {},
    ) {
      const { repos, ids } = await executionScenario(db);
      const threadId = options.child ? ids.child : ids.caller;
      const claim = createDrizzleRunClaim(db);
      const eventWriter = createDrizzleEventJournalWriter(db);
      let threshold: number | undefined = 2500;
      const source = createTestAgentBinding("gpt-4.1-mini", "Write stories.", () => [threadId]);
      const binding = {
        ...source,
        async readThreadBinding(id: string) {
          const result = await source.readThreadBinding(id);
          if (result?.revision) result.revision.definition.metadata.autocompact = threshold;
          return result;
        },
      };
      const gateway = options.gateway ?? scriptedGateway();
      const summarizer = options.summarizer ?? scriptedSummarizer();
      const { createDrizzleCreditLedger } = await import("../../billing/index.js");
      const rig = createRuntimeHarness({
        creditLedger: createDrizzleCreditLedger(db),
        repos,
        eventWriter,
        runClaim: claim,
        agentRevisions: binding,
        summarizer,
        gateway: {
          ...gateway,
          listModels: () => [
            {
              id: "gpt-4.1-mini",
              provider: "openai",
              displayName: "Fixture",
              contextWindow: 128000,
              maxOutputTokens: 100,
              promptCache: { kind: "automatic", ttlMs: 60000 },
              capabilities: new Set(["image_input"]),
            },
          ],
        },
        delivery: createTestDrizzleDelivery(db, {
          repos,
          eventWriter,
          runClaim: claim,
          notices: options.notices ?? createDrizzleNoticePort(db),
        }),
      });
      await rig.creditLedger.grant({
        userId: ids.user,
        source: "manual",
        amountMillicredits: "1000000000",
        reason: "fixture",
      });
      const previous = (await repos.turns.listByThread(threadId)).at(-1);
      const history = await repos.turns.create({
        threadId,
        prevTurnId: previous?.id,
        role: "user",
        origin: "writer",
        status: "complete",
      });
      await repos.blocks.create({
        turnId: history.id,
        blockType: "text",
        sequence: 0,
        content: options.history ?? "old history ".repeat(1500),
        textContent: options.history ?? "old history ".repeat(1500),
        status: "complete",
      });
      const answer = await repos.turns.create({
        threadId,
        prevTurnId: history.id,
        role: "assistant",
        origin: "assistant",
        status: "complete",
      });
      await repos.blocks.create({
        turnId: answer.id,
        blockType: "text",
        sequence: 0,
        content: "old answer",
        textContent: "old answer",
        status: "complete",
      });
      rig.deps.toolExecutor.getDefinitions = () => [];
      return {
        ...rig,
        threadId,
        gateway,
        summarizer,
        ids,
        setThreshold(value: number | undefined) {
          threshold = value;
        },
      };
    }

    async function addImagePrompt(
      rig: Awaited<ReturnType<typeof fixture>>,
      images: Array<{ key: string; sizeBytes: number; included: boolean }>,
    ) {
      const previous = (await rig.repos.turns.listByThread(rig.threadId)).at(-1);
      const userTurn = await rig.repos.turns.create({
        threadId: rig.threadId,
        prevTurnId: previous?.id,
        role: "user",
        origin: "writer",
        status: "complete",
      });
      await rig.repos.blocks.create({
        turnId: userTurn.id,
        blockType: "text",
        sequence: 0,
        content: "Image references.",
        textContent: "Image references.",
        status: "complete",
      });
      const savedImages = await Promise.all(
        images.map(async ({ key }, sequence) => {
          const documentId = `image-${key}`;
          const uri = `scratch://${key}.png`;
          const block = await rig.repos.blocks.create({
            turnId: userTurn.id,
            blockType: "image",
            sequence: sequence + 1,
            content: { type: "image_reference", documentId, uri },
            status: "complete",
          });
          return { block, documentId, uri };
        }),
      );
      const excluded = savedImages.filter((_, index) => !images[index]?.included);
      let exclusionTurnId = userTurn.id;
      if (excluded.length > 0) {
        const breaks = excluded.map(({ block, uri }) => ({
          blockId: block.id,
          uri,
          reason: "budget_eviction" as const,
        }));
        const notice = await rig.repos.turns.create({
          threadId: rig.threadId,
          prevTurnId: userTurn.id,
          role: "system",
          origin: "system",
          status: "complete",
          metadata: encodeImageInclusionMetadata(breaks),
        });
        await rig.repos.blocks.create({
          turnId: notice.id,
          blockType: "text",
          sequence: 0,
          content: `<system_update>\nImage context changed.\n${breaks.map(({ uri }) => `Removed ${uri} to fit the image context budget.`).join("\n")}\n</system_update>`,
          textContent: `<system_update>\nImage context changed.\n${breaks.map(({ uri }) => `Removed ${uri} to fit the image context budget.`).join("\n")}\n</system_update>`,
          status: "complete",
        });
        exclusionTurnId = notice.id;
      }
      for (const [index, { block }] of savedImages.entries()) {
        await rig.repos.imageInclusions.set({
          threadId: rig.threadId,
          blockId: block.id,
          decisionTurnId: images[index]?.included ? userTurn.id : exclusionTurnId,
          included: images[index]?.included ?? false,
        });
      }
      const assets = new Map(images.map((image) => [`image-${image.key}`, image]));
      const resolutionCounts = new Map<string, number>();
      rig.deps.imageAssets = {
        async resolve(_context, reference) {
          resolutionCounts.set(
            reference.documentId,
            (resolutionCounts.get(reference.documentId) ?? 0) + 1,
          );
          const asset = assets.get(reference.documentId);
          if (asset?.key === "transient") throw new ImageAssetResolutionError("retry later");
          if (!asset) return null;
          return {
            mediaType: "image/png",
            data: `data:image/png;base64,${asset.key}`,
            sizeBytes: asset.sizeBytes,
          };
        },
      };
      return { userTurn, savedImages, assets, resolutionCounts };
    }

    function requestImageData(request: import("../gateway/index.js").GenerateRequest) {
      return request.messages
        .flatMap((message) => message.content)
        .filter((part) => part.type === "image")
        .map((part) => part.data);
    }

    async function imageFixture(
      options: { summarizer?: ReturnType<typeof scriptedSummarizer> } = {},
    ) {
      const rig = await fixture({ history: "old history ".repeat(8000), ...options });
      rig.setThreshold(8000);
      return rig;
    }

    it("re-admits a retained eviction on C and makes B match its stored rebuild", async () => {
      const rig = await imageFixture();
      const { savedImages } = await addImagePrompt(rig, [
        { key: "retained", sizeBytes: 1024 * 1024, included: false },
      ]);
      const imageData = "data:image/png;base64,retained";
      const run = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        tools: [],
        userText: "Continue.",
      });

      expect((await run.execute()).status).toBe("complete");
      const turns = await rig.repos.turns.listByThread(rig.threadId);
      const compaction = turns.find((turn) => turn.role === "compaction");
      if (!compaction) throw new Error("Missing compaction turn");
      expect(
        (await rig.repos.imageInclusions.listByThread(rig.threadId)).filter(
          (row) => row.blockId === savedImages[0]?.block.id && row.decisionTurnId === compaction.id,
        ),
      ).toEqual([
        {
          threadId: rig.threadId,
          blockId: savedImages[0]?.block.id,
          decisionTurnId: compaction.id,
          included: true,
        },
      ]);

      const request = rig.gateway.requests[0];
      expect(requestImageData(request)).toContain(imageData);
      const summary = (await rig.repos.blocks.listByTurn(compaction.id)).find(
        (block) => block.blockType === "custom",
      );
      const tokensAfter = (summary?.content as { props?: { tokensAfter?: unknown } } | null)?.props
        ?.tokensAfter;
      expect(tokensAfter).toBe(estimateRequestTokens({ request, baseline: null }));
      const thread = await rig.repos.threads.findById(rig.threadId);
      if (!thread) throw new Error("Missing thread");
      const rebuilt = await assembleNextTurnContext({
        thread,
        turns: turns.slice(0, -1),
        blocks: (await rig.repos.blocks.listByThread(rig.threadId)).filter(
          (block) => block.turnId !== turns.at(-1)?.id,
        ),
        agentRevisions: rig.deps.agentRevisions,
        toolRegistry: rig.deps.toolRegistry,
        baseTools: [],
        gateway: rig.deps.gateway,
        imageAssets: rig.deps.imageAssets,
        imageInclusions: rig.repos.imageInclusions,
        promptBakes: rig.repos.promptBakes,
        workContext: rig.deps.workContext,
      });
      expect(promptBytes(request)).toBe(promptBytes(rebuilt.generateRequest));
    });

    it("fills the remaining budget from multiple retained candidates, newest first", async () => {
      const rig = await imageFixture();
      const mib = 1024 * 1024;
      const { savedImages } = await addImagePrompt(rig, [
        { key: "oldest", sizeBytes: 7 * mib, included: false },
        { key: "middle", sizeBytes: 8 * mib, included: false },
        { key: "newest", sizeBytes: 9 * mib, included: false },
      ]);
      const run = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        tools: [],
        userText: "Continue.",
      });

      expect((await run.execute()).status).toBe("complete");
      const compaction = (await rig.repos.turns.listByThread(rig.threadId)).find(
        (turn) => turn.role === "compaction",
      );
      if (!compaction) throw new Error("Missing compaction turn");
      const reAdmissions = (await rig.repos.imageInclusions.listByThread(rig.threadId))
        .filter((row) => row.decisionTurnId === compaction.id)
        .map(({ blockId, included }) => ({
          key: savedImages.find(({ block }) => block.id === blockId)?.documentId,
          included,
        }));
      expect(new Set(reAdmissions.map(({ key }) => key))).toEqual(
        new Set(["image-newest", "image-middle"]),
      );
      expect(reAdmissions.every(({ included }) => included)).toBe(true);
      expect(requestImageData(rig.gateway.requests[0])).toEqual([
        "data:image/png;base64,middle",
        "data:image/png;base64,newest",
      ]);
    });

    it("keeps candidates fill-only while a same-pass late image uses normal eviction", async () => {
      let rig: Awaited<ReturnType<typeof fixture>>;
      const mib = 1024 * 1024;
      let assets = new Map<string, { key: string; sizeBytes: number; included: boolean }>();
      const summarizer = scriptedSummarizer(async () => {
        assets.set("image-late", { key: "late", sizeBytes: 9 * mib, included: false });
        await rig.send(rig.threadId, "late image", {
          blocks: [
            { type: "text", text: "late image" },
            { type: "image", documentId: "image-late", uri: "scratch://late.png" },
          ],
        });
        return {
          kind: "complete",
          text: "Earlier context.",
          model: "summary-model",
          modelResponses: [],
        };
      });
      rig = await imageFixture({ summarizer });
      const { savedImages, assets: imageAssets } = await addImagePrompt(rig, [
        { key: "old-included", sizeBytes: 8 * mib, included: true },
        { key: "new-included", sizeBytes: 6 * mib, included: true },
        { key: "candidate", sizeBytes: 5 * mib, included: false },
      ]);
      assets = imageAssets;
      const run = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        tools: [],
        userText: "Continue.",
      });

      expect((await run.execute()).status).toBe("complete");
      const compaction = (await rig.repos.turns.listByThread(rig.threadId)).find(
        (turn) => turn.role === "compaction",
      );
      if (!compaction) throw new Error("Missing compaction turn");
      const rows = await rig.repos.imageInclusions.listByThread(rig.threadId);
      expect(
        rows.some(
          (row) =>
            row.blockId === savedImages[2]?.block.id &&
            row.decisionTurnId === compaction.id &&
            row.included,
        ),
      ).toBe(true);
      const latest = new Map(
        (await rig.repos.imageInclusions.findByThread(rig.threadId)).map((row) => [
          row.blockId,
          row,
        ]),
      );
      expect(latest.get(savedImages[0]?.block.id ?? "")?.included).toBe(false);
      expect(latest.get(savedImages[1]?.block.id ?? "")?.included).toBe(true);
      expect(latest.get(savedImages[2]?.block.id ?? "")?.included).toBe(true);
      expect(requestImageData(rig.gateway.requests[0])).toEqual([
        "data:image/png;base64,new-included",
        "data:image/png;base64,candidate",
        "data:image/png;base64,late",
      ]);
      const turns = await rig.repos.turns.listByThread(rig.threadId);
      const evictionNotice = turns
        .map((turn) => ({ turn, metadata: decodeImageInclusionMetadata(turn.metadata) }))
        .find(({ metadata }) =>
          metadata?.breaks.some((entry) => entry.blockId === savedImages[0]?.block.id),
        );
      expect(evictionNotice?.turn.position).toBeGreaterThan(compaction.position);
      expect(evictionNotice?.metadata?.breaks).toContainEqual({
        blockId: savedImages[0]?.block.id,
        uri: "scratch://old-included.png",
        reason: "budget_eviction",
      });
    });

    it("skips a transient candidate resolution without failing or deciding C", async () => {
      const rig = await imageFixture();
      const { savedImages, resolutionCounts } = await addImagePrompt(rig, [
        { key: "transient", sizeBytes: 1024, included: false },
      ]);
      const run = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        tools: [],
        userText: "Continue.",
      });

      expect((await run.execute()).status).toBe("complete");
      const compaction = (await rig.repos.turns.listByThread(rig.threadId)).find(
        (turn) => turn.role === "compaction",
      );
      if (!compaction) throw new Error("Missing compaction turn");
      expect(resolutionCounts.get("image-transient")).toBeGreaterThan(0);
      expect(
        (await rig.repos.imageInclusions.listByThread(rig.threadId)).some(
          (row) => row.blockId === savedImages[0]?.block.id && row.decisionTurnId === compaction.id,
        ),
      ).toBe(false);
      expect(requestImageData(rig.gateway.requests[0])).toEqual([]);
    });

    it("does not persist candidate decisions when compaction fails", async () => {
      const rig = await imageFixture({
        summarizer: scriptedSummarizer(async () => ({
          kind: "failed",
          error: new Error("summary failed"),
          modelResponses: [],
        })),
      });
      const { savedImages } = await addImagePrompt(rig, [
        { key: "retained", sizeBytes: 1024 * 1024, included: false },
      ]);
      const run = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        tools: [],
        userText: "Continue.",
      });

      expect((await run.execute()).status).toBe("error");
      const compaction = (await rig.repos.turns.listByThread(rig.threadId)).find(
        (turn) => turn.role === "compaction",
      );
      if (!compaction) throw new Error("Missing compaction turn");
      expect(
        (await rig.repos.imageInclusions.listByThread(rig.threadId)).filter(
          (row) => row.blockId === savedImages[0]?.block.id,
        ),
      ).toHaveLength(1);
      expect(rig.gateway.requests).toEqual([]);
      expect(compaction.status).toBe("error");
    });

    it("settles both rows when a warm overflow falls back cold", async () => {
      const gateway = scriptedGateway();
      const original = gateway.stream;
      let summaries = 0;
      gateway.stream = async function* (request) {
        const isSummary = request.messages.some((message) =>
          message.content.some(
            (part) => part.type === "text" && part.text.includes("Summarize this conversation"),
          ),
        );
        if (!isSummary) {
          yield* original(request);
          return;
        }
        summaries++;
        if (summaries === 1) {
          yield { type: "usage", usage: { inputTokens: 100, outputTokens: 1 } };
          yield {
            type: "error",
            code: "context_overflow",
            message: "input length and max_tokens exceed context limit",
            retryable: false,
          };
          return;
        }
        yield {
          type: "end",
          result: {
            content: [{ type: "text", text: "The earlier work is complete." }],
            toolCalls: [],
            finishReason: "end_turn",
            usage: { inputTokens: 100, outputTokens: 10 },
            model: "gpt-4.1-mini",
            provider: "openai",
          },
        };
      };
      const rig = await fixture({ gateway });
      rig.deps.summarizer = createConversationSummarizer({
        gateway: rig.deps.gateway,
        agentRevisions: rig.deps.agentRevisions,
        prefixCacheStateFor: async () => ({ state: "warm", reason: "reusable_prefix" }),
        config: { model: "gpt-4.1-mini", maxOutputTokens: 100 },
      });
      const run = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        tools: [],
        userText: "Continue.",
      });
      expect((await run.execute()).status).toBe("complete");
      expect(summaries).toBe(2);
      const rows = await rig.repos.modelResponses.listByTurn(run.executionTurnId);
      expect(rows).toHaveLength(2);
      expect(
        rows.map((row) => [row.finishReason, row.predictedCacheState, row.predictedCacheReason]),
      ).toEqual([
        ["error", "warm", "reusable_prefix"],
        ["end_turn", "cold", "summary_transcript"],
      ]);
      const debits = await db.select().from(schema.creditTransactions);
      for (const row of rows) {
        expect(BigInt(row.millicredits ?? "0")).toBeGreaterThan(0n);
        expect(debits.filter((debit) => debit.usageEventId === row.id)).toHaveLength(1);
      }
    });

    it.each([
      "recovered",
      "second_overflow",
      "new_reply",
    ])("forces cold after provider overflow and retries once (%s)", async (scenario) => {
      const secondOverflow = scenario === "second_overflow";
      let rig: Awaited<ReturnType<typeof fixture>>;
      const gateway = scriptedGateway();
      let calls = 0;
      let summaries = 0;
      const requests: import("../gateway/index.js").GenerateRequest[] = [];
      gateway.stream = async function* (request) {
        requests.push(request);
        const summary = request.messages.some((message) =>
          message.content.some(
            (part) => part.type === "text" && part.text.includes("Summarize this conversation"),
          ),
        );
        if (summary) {
          summaries++;
          yield {
            type: "end",
            result: {
              content: [{ type: "text", text: "The earlier work is complete." }],
              toolCalls: [],
              finishReason: "end_turn",
              usage: { inputTokens: 100, outputTokens: 10 },
              model: "gpt-4.1-mini",
              provider: "openai",
            },
          };
          return;
        }
        calls++;
        if (calls === 1 || secondOverflow || (scenario === "new_reply" && calls === 3)) {
          yield {
            type: "error",
            code: "context_overflow",
            message: "Provider window exceeded",
            retryable: false,
          };
          return;
        }
        if (scenario === "new_reply" && calls === 2)
          await rig.send(rig.threadId, "A new writer request.");
        yield {
          type: "end",
          result: {
            content: [{ type: "text", text: "Continued after compaction." }],
            toolCalls: [],
            finishReason: "end_turn",
            usage: { inputTokens: 100, outputTokens: 10 },
            model: "gpt-4.1-mini",
            provider: "openai",
          },
        };
      };
      rig = await fixture({ gateway });
      rig.setThreshold(undefined);
      const real = createConversationSummarizer({
        gateway: rig.deps.gateway,
        agentRevisions: rig.deps.agentRevisions,
        prefixCacheStateFor: async () => ({ state: "warm", reason: "reusable_prefix" }),
        config: { model: "gpt-4.1-mini", maxOutputTokens: 100 },
      });
      const inputs: Parameters<typeof real.summarize>[0][] = [];
      rig.deps.summarizer = {
        ...real,
        async summarize(input) {
          inputs.push(input);
          return real.summarize(input);
        },
      };
      const run = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        tools: [],
        userText: "Continue.",
      });
      const result = await run.execute();
      expect(calls).toBe(scenario === "new_reply" ? 4 : 2);
      expect(summaries).toBe(scenario === "new_reply" ? 2 : 1);
      expect(inputs[0].forceCold).toBe(true);
      expect(inputs[0].projection.blocks.some((block) => block.textContent === "Continue.")).toBe(
        false,
      );
      const turns = await rig.repos.turns.listByThread(rig.threadId);
      const [a, c, b] = turns.slice(-3);
      expect([a.role, c.role, b.role]).toEqual(["assistant", "compaction", "assistant"]);
      expect(a.status).toBe("complete");
      expect(await rig.repos.blocks.listByTurn(a.id)).toEqual([]);
      expect(c).toMatchObject({
        status: "complete",
        metadata: { summarizer: { path: "cold", segments: 1 } },
      });
      expect(result.status).toBe(secondOverflow ? "error" : "complete");
      if (secondOverflow) {
        expect(b.error).toContain("context window after compaction");
        const events = await db
          .select({ payload: schema.eventJournal.payload })
          .from(schema.eventJournal);
        expect(JSON.stringify(events)).toContain("context_window_exceeded");
      }
      expect(await rig.inbox.selectPending(rig.threadId)).toEqual([]);
      expect(JSON.stringify(requests.at(-1))).toContain("The earlier work is complete.");
    });

    it.each([
      "complete",
      "failed",
      "cancelled",
    ] as const)("settles real summary responses on %s, with prediction, message count and debit", async (ending) => {
      let rig: Awaited<ReturnType<typeof fixture>>;
      const gateway = scriptedGateway();
      const original = gateway.stream;
      gateway.stream = async function* (request) {
        if (
          request.messages.some((message) =>
            message.content.some(
              (part) => part.type === "text" && part.text.includes("Summarize this conversation"),
            ),
          )
        ) {
          yield {
            type: "usage",
            usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 60 },
          };
          if (ending === "cancelled") {
            const current = await rig.runClaim.readRunningTurnId(rig.threadId);
            if (!current) throw new Error("Missing current summary");
            await rig.orchestrator.cancel(rig.threadId, current);
            return;
          }
          yield {
            type: "end",
            result: {
              model: "gpt-4.1-mini",
              provider: "openai",
              content: [{ type: "text", text: "Story facts and writer preferences." }],
              toolCalls: [],
              finishReason: ending === "failed" ? "max_tokens" : "end_turn",
              usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 60 },
            },
          };
          return;
        }
        yield* original(request);
      };
      rig = await fixture({ gateway });
      rig.deps.summarizer = createConversationSummarizer({
        gateway: rig.deps.gateway,
        agentRevisions: rig.deps.agentRevisions,
        prefixCacheStateFor: createPrefixCacheStateService({ repos: rig.repos })
          .prefixCacheStateFor,
        config: { model: "disabled-cheap-model", maxOutputTokens: 100 },
      });
      const run = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        tools: [],
        userText: "Continue.",
      });
      const terminal = await run.execute();
      expect(terminal.status).toBe(ending === "failed" ? "error" : ending);
      const c = await rig.repos.turns.findById(run.executionTurnId);
      expect(c).toMatchObject({
        status: ending === "failed" ? "error" : ending,
        metadata: { summarizer: { path: "cold", segments: 1 } },
      });
      const rows = await rig.repos.modelResponses.listByTurn(run.executionTurnId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        inputTokens: 100,
        outputTokens: 10,
        requestMessageCount: 2,
        predictedCacheState: "cold",
        predictedCacheReason: "summary_transcript",
      });
      expect(BigInt(rows[0].millicredits ?? "0")).toBeGreaterThan(0n);
      const debits = (await db.select().from(schema.creditTransactions)).filter(
        (row) => row.usageEventId === rows[0].id,
      );
      expect(debits).toHaveLength(1);
    });

    it("includes discarded warm and every cold segment response in a child report's cost", async () => {
      const rig = await fixture({ child: true, history: "short history ".repeat(100) });
      const model = {
        id: "gpt-4.1-mini",
        provider: "openai",
        displayName: "Fixture",
        contextWindow: 6_000,
        maxOutputTokens: 100,
        promptCache: { kind: "automatic" as const, ttlMs: 60_000 },
        capabilities: new Set<import("../gateway/index.js").Capability>(["tool_calling"]),
      };
      rig.deps.gateway.listModels = () => [model];
      const originalStream = rig.deps.gateway.stream.bind(rig.deps.gateway);
      const requests: import("../gateway/index.js").GenerateRequest[] = [];
      let summaryCalls = 0;
      rig.deps.gateway.stream = async function* (request) {
        requests.push(request);
        const isSummary = request.messages.some((message) =>
          message.content.some(
            (part) => part.type === "text" && part.text.includes("Summarize this conversation"),
          ),
        );
        if (!isSummary) {
          yield* originalStream(request);
          return;
        }
        summaryCalls++;
        yield {
          type: "end",
          result: {
            content:
              summaryCalls === 1
                ? [{ type: "tool_use", toolCallId: "discarded-warm", toolName: "read", input: {} }]
                : [{ type: "text", text: `Cold segment ${summaryCalls - 1} summary.` }],
            toolCalls:
              summaryCalls === 1 ? [{ id: "discarded-warm", name: "read", arguments: {} }] : [],
            finishReason: summaryCalls === 1 ? "tool_use" : "end_turn",
            usage: { inputTokens: 100, outputTokens: 10 },
            model: model.id,
            provider: model.provider,
          },
        };
      };
      rig.deps.summarizer = createConversationSummarizer({
        gateway: rig.deps.gateway,
        agentRevisions: rig.deps.agentRevisions,
        prefixCacheStateFor: async () => ({ state: "warm", reason: "reusable_prefix" }),
        config: { model: model.id, maxOutputTokens: 100 },
      });

      let previousTurnId = (await rig.repos.turns.listByThread(rig.threadId)).at(-1)?.id;
      for (let index = 0; index < 6; index++) {
        const turn = await rig.repos.turns.create({
          threadId: rig.threadId,
          prevTurnId: previousTurnId,
          role: index % 2 === 0 ? "user" : "assistant",
          origin: index % 2 === 0 ? "writer" : "assistant",
          status: "complete",
        });
        await rig.repos.blocks.create({
          turnId: turn.id,
          blockType: "text",
          sequence: 0,
          content: `Chapter clue ${index}. ${"distinctive lore ".repeat(500)}`,
          textContent: `Chapter clue ${index}. ${"distinctive lore ".repeat(500)}`,
          status: "complete",
        });
        previousTurnId = turn.id;
      }

      const run = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        tools: [],
        userText: "Continue.",
      });
      const outcome = await run.execute();
      expect(outcome.status).toBe("complete");
      expect(summaryCalls).toBeGreaterThanOrEqual(3);

      const compaction = (await rig.repos.turns.listByThread(rig.threadId)).find(
        (turn) => turn.role === "compaction",
      );
      expect(compaction).toBeDefined();
      if (!compaction) throw new Error("Missing compaction turn");
      const summaryRows = await rig.repos.modelResponses.listByTurn(compaction.id);
      expect(summaryRows).toHaveLength(summaryCalls);
      expect(summaryRows[0]).toMatchObject({
        predictedCacheState: "warm",
        predictedCacheReason: "reusable_prefix",
        finishReason: "tool_use",
      });
      expect(
        summaryRows.slice(1).every((row) => row.predictedCacheReason === "summary_transcript"),
      ).toBe(true);

      const report = await rig.repos.executionReports.findByExecution(
        rig.threadId,
        run.executionTurnId,
      );
      const allRows = await rig.repos.modelResponses.listByThread(rig.threadId);
      expect(report?.costMillicredits).toBe(
        allRows.reduce((sum, row) => sum + Number(row.millicredits ?? "0"), 0),
      );
      const debits = await db.select().from(schema.creditTransactions);
      for (const row of summaryRows) {
        expect(BigInt(row.millicredits ?? "0")).toBeGreaterThan(0n);
        expect(debits.filter((debit) => debit.usageEventId === row.id)).toHaveLength(1);
      }
      expect(requests.length).toBeGreaterThan(summaryCalls);
    });

    it("stops the successor iteration when settled compaction cost exhausts the tree budget", async () => {
      const summarizer = scriptedSummarizer(async ({ turnId }) => ({
        kind: "complete",
        text: "Earlier facts.",
        model: "gpt-4.1-mini",
        modelResponses: [
          {
            id: crypto.randomUUID(),
            turnId,
            sequence: 0,
            provider: "openai",
            model: "gpt-4.1-mini",
            inputTokens: 100_000,
            outputTokens: 20,
            requestMessageCount: 7,
            priceSource: "unknown",
            predictedCacheState: "cold",
            predictedCacheReason: "summary_transcript",
          },
        ],
      }));
      const rig = await fixture({ summarizer });
      const treeBudget = createDefaultTreeBudget({ maxCostMillicredits: 1 });
      const run = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        treeBudget,
        tools: [],
        userText: "Continue.",
      });

      expect((await run.execute()).status).toBe("error");
      const compaction = await rig.repos.turns.findById(run.executionTurnId);
      expect(compaction).toMatchObject({ role: "compaction", status: "complete" });
      const summaryRows = await rig.repos.modelResponses.listByTurn(run.executionTurnId);
      expect(summaryRows).toHaveLength(1);
      expect(Number(summaryRows[0]?.millicredits)).toBeGreaterThan(treeBudget.maxCostMillicredits);
      expect(treeBudget.spent.costMillicredits).toBe(Number(summaryRows[0]?.millicredits));
      expect(treeBudget.spent.totalTurns).toBe(0);
      expect(rig.gateway.requests).toEqual([]);

      const terminal = (await rig.repos.turns.listByThread(rig.threadId)).at(-1);
      expect(terminal).toMatchObject({ role: "assistant", status: "error" });
      expect(terminal?.error).toContain("Cost budget exhausted (1 millicredits)");
    });

    it.each([
      false,
      true,
    ])("reserves C at run start and commits B over an unchanged rebake (child=%s)", async (child) => {
      const rig = await fixture({ child });
      const run = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        tools: [],
        userText: "Continue.",
      });
      const c = (await rig.repos.turns.listByThread(rig.threadId)).at(-1);
      if (!c) throw new Error("Missing reserved turn");
      if (c.role !== "compaction") {
        const result = await run.execute();
        throw new Error(JSON.stringify(result));
      }
      expect(c).toMatchObject({ role: "compaction", status: "pending" });
      expect(await rig.runClaim.readRunningTurnId(rig.threadId)).toBe(c.id);
      const initialBake = (await rig.repos.threads.findById(rig.threadId))?.initialPromptBakeId;
      if (child)
        expect(
          (await rig.repos.executionReports.findByExecution(rig.threadId, c.id))?.executionTurnId,
        ).toBe(c.id);
      const result = await run.execute();
      expect(result.status).toBe("complete");
      const turns = await rig.repos.turns.listByThread(rig.threadId);
      expect(turns.slice(-3).map((turn) => [turn.role, turn.status])).toEqual([
        ["user", "complete"],
        ["compaction", "complete"],
        ["assistant", "complete"],
      ]);
      expect((await rig.repos.turns.findById(c.id))?.promptBakeId).toBe(initialBake);
      expect(rig.summarizer.calls).toHaveLength(1);
      const thread = await rig.repos.threads.findById(rig.threadId);
      if (!thread) throw new Error("Missing thread");
      const rebuilt = await assembleNextTurnContext({
        thread,
        turns: turns.slice(0, -1),
        blocks: (await rig.repos.blocks.listByThread(rig.threadId)).filter(
          (block) => block.turnId !== turns.at(-1)?.id,
        ),
        agentRevisions: rig.deps.agentRevisions,
        toolRegistry: rig.deps.toolRegistry,
        baseTools: [],
        gateway: rig.deps.gateway,
        promptBakes: rig.repos.promptBakes,
        workContext: rig.deps.workContext,
      });
      expect(promptBytes(rig.gateway.requests[0])).toBe(promptBytes(rebuilt.generateRequest));
      expect(await rig.repos.modelResponses.listByTurn(turns[turns.length - 1].id)).toMatchObject([
        { requestMessageCount: rig.gateway.requests[0].messages.length },
      ]);
    });

    it("lands a summarizer cancellation on a live signal as a failed reply", async () => {
      const summarizer = scriptedSummarizer(async ({ signal }) => {
        expect(signal.aborted).toBe(false);
        return { kind: "cancelled", modelResponses: [] };
      });
      const rig = await fixture({ summarizer });
      const run = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        tools: [],
        userText: "Continue.",
      });
      expect((await run.execute()).status).toBe("error");
      expect(
        (await rig.repos.turns.listByThread(rig.threadId)).slice(-2).map((t) => [t.role, t.status]),
      ).toEqual([
        ["compaction", "error"],
        ["assistant", "error"],
      ]);
      expect(await rig.inbox.selectPending(rig.threadId)).toEqual([]);
    });

    it("logs a throwing summarizer as an adapter bug and lands a failed reply", async () => {
      const summarizer = scriptedSummarizer(async () => {
        throw new Error("summary adapter bug");
      });
      const rig = await fixture({ summarizer });
      const sink = createInMemoryEventSink();
      rig.deps.eventSink = sink;
      const run = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        tools: [],
        userText: "Continue.",
      });
      expect((await run.execute()).status).toBe("error");
      expect(sink.events).toContainEqual(
        expect.objectContaining({
          level: "error",
          name: "summarizer.threw",
        }),
      );
      expect(
        (await rig.repos.turns.listByThread(rig.threadId))
          .slice(-2)
          .map((turn) => [turn.role, turn.status]),
      ).toEqual([
        ["compaction", "error"],
        ["assistant", "error"],
      ]);
      expect(await rig.inbox.selectPending(rig.threadId)).toEqual([]);
    });

    it.each([
      { compaction: true, remote: false, successor: false },
      { compaction: false, remote: false, successor: false },
      { compaction: true, remote: false, successor: true },
      { compaction: false, remote: false, successor: true },
      { compaction: true, remote: true, successor: false },
      { compaction: false, remote: true, successor: false },
      { compaction: true, remote: true, successor: true },
      { compaction: false, remote: true, successor: true },
    ])("stops across a committed successor window ($compaction, $remote, $successor)", async ({
      compaction,
      remote,
      successor,
    }) => {
      const rig = await fixture({ history: compaction ? undefined : "brief history" });
      const canceller = remote
        ? createOrchestrator({ ...rig.deps, runClaim: createDrizzleRunClaim(db) })
        : rig.orchestrator;
      const split = rig.delivery.splitAndContinue;
      let cancelled = false;
      let cancelResult: string | undefined;
      rig.delivery.splitAndContinue = async (input) => {
        const result = await split(input);
        if (result.split && !cancelled) {
          cancelled = true;
          expect(await rig.runClaim.readRunningTurnId(rig.threadId)).toBe(result.next.id);
          cancelResult = await canceller.cancel(
            rig.threadId,
            successor ? result.next.id : input.currentTurn.id,
          );
        }
        return result;
      };
      const run = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        tools: [],
        userText: "Continue.",
      });
      if (!compaction) await rig.send(rig.threadId, "Split now.");
      expect((await run.execute()).status).toBe("cancelled");
      expect(cancelled).toBe(true);
      expect(cancelResult).toBe("cancelled");
      expect((await rig.repos.turns.listByThread(rig.threadId)).at(-1)?.status).toBe("cancelled");
      expect(await rig.orchestrator.cancel(rig.threadId, run.executionTurnId)).toBe(
        "already_finished",
      );
    });

    it("does not mistake an internal tool AbortError for a requested stop", async () => {
      const gateway = scriptedGateway({
        results: [
          {
            content: [
              { type: "tool_use", toolCallId: "internal-abort", toolName: "ls", input: {} },
            ],
            toolCalls: [],
            finishReason: "tool_use",
            usage: { inputTokens: 10, outputTokens: 10 },
            model: "gpt-4.1-mini",
            provider: "openai",
          },
        ],
      });
      const rig = await fixture({ history: "brief history", gateway });
      rig.deps.toolExecutor.executeTool = async () => {
        throw new DOMException("internal timeout", "AbortError");
      };
      const run = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        tools: [
          {
            type: "function",
            name: "ls",
            description: "List",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        userText: "Continue.",
      });
      expect((await run.execute()).status).toBe("error");
      expect((await rig.repos.turns.findById(run.executionTurnId))?.status).toBe("error");
    });

    it("lands an impossible pinned request as a failed reply without C and acknowledges it", async () => {
      const rig = await fixture();
      const run = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        tools: [],
        userText: "too big ".repeat(5000),
      });
      expect((await run.execute()).status).toBe("error");
      const turns = await rig.repos.turns.listByThread(rig.threadId);
      expect(turns.some((turn) => turn.role === "compaction")).toBe(false);
      expect(turns.at(-1)?.error).toBe("This message is too long for this chat's model.");
      expect(await rig.inbox.selectPending(rig.threadId)).toEqual([]);
    });
    it("rejects an impossible mid-run arrival without reserving C", async () => {
      let rig: Awaited<ReturnType<typeof fixture>>;
      const gateway = scriptedGateway({
        onStream: async (call) => {
          if (call === 1) await rig.send(rig.threadId, "Too large. ".repeat(5000));
        },
      });
      rig = await fixture({ history: "brief history", gateway });
      const run = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        tools: [],
        userText: "Continue.",
      });
      expect((await run.execute()).status).toBe("error");
      const turns = await rig.repos.turns.listByThread(rig.threadId);
      expect(turns.some((turn) => turn.role === "compaction")).toBe(false);
      expect(turns.at(-1)?.error).toBe("This message is too long for this chat's model.");
      expect(await rig.inbox.selectPending(rig.threadId)).toEqual([]);
    });

    it.each([
      false,
      true,
    ])("orders writer and agent arrivals after C and lands the reply below both (failure=%s)", async (failure) => {
      let rig: Awaited<ReturnType<typeof fixture>>;
      let writerId = "";
      let agentId = "";
      const summarizer = scriptedSummarizer(async ({ turnId }) => {
        expect(await rig.runClaim.readRunningTurnId(rig.threadId)).toBe(turnId);
        expect(await rig.runClaim.read(rig.threadId)).toMatchObject({ phase: "compacting" });
        writerId = (await rig.send(rig.threadId, "late writer")).userTurnId;
        agentId = (
          await rig.delivery.enqueue({
            threadId: rig.threadId,
            intent: "message",
            provenance: { kind: "agent", threadId: rig.ids.child },
            body: { kind: "text", text: "late agent" },
            idempotencyKey: "late-agent",
          })
        ).id;
        const modelResponses = [
          {
            id: crypto.randomUUID(),
            turnId,
            sequence: 0,
            provider: "openai",
            model: "gpt-4.1-mini",
            inputTokens: 100,
            outputTokens: 10,
            requestMessageCount: 7,
            priceSource: "unknown" as const,
            predictedCacheState: "cold" as const,
            predictedCacheReason: "summary_transcript" as const,
          },
        ];
        return failure
          ? { kind: "failed", error: new Error("summary failed"), modelResponses }
          : {
              kind: "complete",
              text: "Earlier context.",
              model: "summary-model",
              modelResponses,
            };
      });
      rig = await fixture({ summarizer });
      const run = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        tools: [],
        userText: "Continue.",
      });
      expect((await run.execute()).status).toBe(failure ? "error" : "complete");
      const tail = (await rig.repos.turns.listByThread(rig.threadId)).slice(-4);
      expect(tail.map((turn) => turn.role)).toEqual(["compaction", "user", "user", "assistant"]);
      expect(tail.slice(1, 3).map((turn) => turn.id)).toEqual([writerId, agentId]);
      expect(tail[0].status).toBe(failure ? "error" : "complete");
      expect(await rig.repos.modelResponses.listByTurn(tail[0].id)).toMatchObject([
        {
          requestMessageCount: 7,
          predictedCacheState: "cold",
          predictedCacheReason: "summary_transcript",
        },
      ]);
      const rows = await rig.repos.modelResponses.listByTurn(tail[0].id);
      expect(BigInt(rows[0].millicredits ?? "0")).toBeGreaterThan(0n);
      const debits = await db.select().from(schema.creditTransactions);
      expect(debits.some((row) => row.usageEventId === rows[0].id)).toBe(true);
      expect(await rig.inbox.selectPending(rig.threadId)).toEqual([]);
      const before = rig.summarizer.calls[0].requestInHand;
      if (!before) throw new Error("Missing request in hand");
      if (failure) {
        rig.setThreshold(undefined);
        const next = await rig.orchestrator.prepare({
          threadId: rig.threadId,
          tools: [],
          userText: "Continue after failure.",
        });
        expect((await next.execute()).status).toBe("complete");
        expectStablePrefix(before, rig.gateway.requests[0]);
      } else {
        expect(rig.gateway.requests[0].messages[0]).toEqual(before.messages[0]);
        const text = JSON.stringify(rig.gateway.requests[0].messages);
        expect(text).toContain("Earlier context.");
        expect(text).not.toContain("old history");
        expect(text.indexOf("Continue.")).toBeLessThan(text.indexOf("late writer"));
        expect(text.indexOf("late writer")).toBeLessThan(text.indexOf("late agent"));
        for (const message of ["Continue.", "late writer", "late agent"]) {
          expect(text.split(message)).toHaveLength(2);
        }
        expect(tail.map((turn) => [turn.role, turn.status])).toEqual([
          ["compaction", "complete"],
          ["user", "complete"],
          ["user", "complete"],
          ["assistant", "complete"],
        ]);
        const thread = await rig.repos.threads.findById(rig.threadId);
        if (!thread) throw new Error("Missing thread");
        const rebuilt = await assembleNextTurnContext({
          thread,
          turns: (await rig.repos.turns.listByThread(rig.threadId)).slice(0, -1),
          blocks: (await rig.repos.blocks.listByThread(rig.threadId)).filter(
            (block) => block.turnId !== tail[3].id,
          ),
          agentRevisions: rig.deps.agentRevisions,
          toolRegistry: rig.deps.toolRegistry,
          baseTools: [],
          gateway: rig.deps.gateway,
          promptBakes: rig.repos.promptBakes,
          workContext: rig.deps.workContext,
        });
        expect(promptBytes(rig.gateway.requests[0])).toBe(promptBytes(rebuilt.generateRequest));
      }
    });

    it("lands a failed rebake as a failed C and reply with compaction copy", async () => {
      let rig: Awaited<ReturnType<typeof fixture>>;
      const summarizer = scriptedSummarizer(async () => {
        rig.deps.workContext.renderForThread = async () => {
          throw new Error("Work context database unavailable");
        };
        return {
          kind: "complete",
          text: "Usable summary.",
          model: "summary-model",
          modelResponses: [],
        };
      });
      rig = await fixture({ summarizer });
      const run = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        tools: [],
        userText: "Continue.",
      });
      expect((await run.execute()).status).toBe("error");
      const tail = (await rig.repos.turns.listByThread(rig.threadId)).slice(-2);
      expect(tail.map((turn) => [turn.role, turn.status])).toEqual([
        ["compaction", "error"],
        ["assistant", "error"],
      ]);
      expect(tail[1].error).toBe("This conversation couldn't be compacted. Try again.");
      expect(await rig.inbox.selectPending(rig.threadId)).toEqual([]);
    });

    it("keeps a usable epoch when a late image fails preparation", async () => {
      let rig: Awaited<ReturnType<typeof fixture>>;
      let writerId: string | undefined;
      const summarizer = scriptedSummarizer(async () => {
        writerId = (
          await rig.send(rig.threadId, "late image", {
            blocks: [
              { type: "text", text: "late image" },
              { type: "image", documentId: crypto.randomUUID(), uri: "uploads://@/missing.png" },
            ],
          })
        ).userTurnId;
        return {
          kind: "complete",
          text: "Usable summary.",
          model: "summary-model",
          modelResponses: [],
        };
      });
      rig = await fixture({ summarizer });
      rig.deps.imageAssets = {
        async resolve() {
          throw new ImageAssetResolutionError("object-store timeout");
        },
      };
      const run = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        tools: [],
        userText: "Continue.",
      });
      expect((await run.execute()).status).toBe("error");
      const tail = (await rig.repos.turns.listByThread(rig.threadId)).slice(-3);
      expect(tail.map((turn) => [turn.role, turn.status])).toEqual([
        ["compaction", "complete"],
        ["user", "complete"],
        ["assistant", "error"],
      ]);
      expect(tail[0].promptBakeId).toBeTruthy();
      expect(tail[2].prevTurnId).toBe(writerId);
      expect(tail[2].error).toBe("An image in this message couldn't be loaded. Try again.");
      expect(await rig.inbox.selectPending(rig.threadId)).toEqual([]);
    });

    it("keeps a usable epoch when a late paste exceeds the successor budget", async () => {
      let rig: Awaited<ReturnType<typeof fixture>>;
      const summarizer = scriptedSummarizer(async () => {
        await rig.send(rig.threadId, "Late long paste. ".repeat(5000));
        return {
          kind: "complete",
          text: "Usable summary.",
          model: "summary-model",
          modelResponses: [],
        };
      });
      rig = await fixture({ summarizer });
      const run = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        tools: [],
        userText: "Continue.",
      });
      expect((await run.execute()).status).toBe("error");
      const tail = (await rig.repos.turns.listByThread(rig.threadId)).slice(-3);
      expect(tail.map((turn) => [turn.role, turn.status])).toEqual([
        ["compaction", "complete"],
        ["user", "complete"],
        ["assistant", "error"],
      ]);
      expect(tail[0].promptBakeId).toBeTruthy();
      expect(tail[2].error).toBe("This message is too long for this chat's model.");
      expect(await rig.inbox.selectPending(rig.threadId)).toEqual([]);
    });

    it("compacts at close with a pending writer message, completing A before C and B", async () => {
      let rig: Awaited<ReturnType<typeof fixture>>;
      const gateway = scriptedGateway({
        onStream: async (call) => {
          if (call === 1) await rig.send(rig.threadId, "A new direction.");
        },
      });
      rig = await fixture({ history: "brief context", gateway });
      const run = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        tools: [],
        userText: "Continue.",
      });
      expect((await run.execute()).status).toBe("complete");
      const tail = (await rig.repos.turns.listByThread(rig.threadId)).slice(-4);
      expect(tail.map((turn) => [turn.role, turn.status])).toEqual([
        ["assistant", "complete"],
        ["user", "complete"],
        ["compaction", "complete"],
        ["assistant", "complete"],
      ]);
      expect(rig.summarizer.calls).toHaveLength(1);
    });

    it("retries successor preparation under the lock on the third attempt without resummarizing", async () => {
      const { currentDrizzleDb } = await import("../../../shared/drizzle-transaction.js");
      const rig = await fixture();
      const run = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        tools: [],
        userText: "Continue.",
      });
      const render = rig.deps.workContext.renderForThread;
      let attempts = 0;
      const locked: boolean[] = [];
      rig.deps.workContext.renderForThread = async (...args) => {
        attempts++;
        locked.push(currentDrizzleDb(db) !== db);
        if (attempts < 3) await rig.send(rig.threadId, `moved leaf ${attempts}`);
        return render(...args);
      };
      expect((await run.execute()).status).toBe("complete");
      expect(attempts).toBe(3);
      expect(locked).toEqual([false, false, true]);
      expect(rig.summarizer.calls).toHaveLength(1);
      const tail = (await rig.repos.turns.listByThread(rig.threadId)).slice(-4);
      expect(tail.map((turn) => turn.role)).toEqual(["compaction", "user", "user", "assistant"]);
      const blocks = await rig.repos.blocks.listByThread(rig.threadId);
      expect(
        tail.slice(1, 3).map((turn) => blocks.find((block) => block.turnId === turn.id)?.content),
      ).toEqual(["moved leaf 1", "moved leaf 2"]);
      const request = JSON.stringify(rig.gateway.requests[0].messages);
      expect(request.indexOf("moved leaf 1")).toBeLessThan(request.indexOf("moved leaf 2"));
      for (const text of ["moved leaf 1", "moved leaf 2"])
        expect(request.split(text)).toHaveLength(2);
      expect(await rig.inbox.selectPending(rig.threadId)).toEqual([]);
    });
    it.each([
      false,
      true,
    ])("cancels C, settles its response, and wakes the late message (child=%s)", async (child) => {
      let rig: Awaited<ReturnType<typeof fixture>>;
      let lateId = "";
      const summarizer = scriptedSummarizer(async ({ turnId, signal }) => {
        expect(rig.orchestrator.getRunningTurn(rig.threadId)).toMatchObject({
          turnId,
          kind: "compaction",
        });
        const admission = await rig.send(rig.threadId, "Run after cancellation.");
        expect(admission.assistantTurnId).toBeNull();
        lateId = admission.userTurnId;
        rig.setThreshold(undefined);
        await rig.orchestrator.cancel(rig.threadId, turnId);
        expect(signal.aborted).toBe(true);
        return {
          kind: "cancelled",
          modelResponses: [
            {
              id: crypto.randomUUID(),
              turnId,
              sequence: 0,
              provider: "openai",
              model: "gpt-4.1-mini",
              inputTokens: 100,
              outputTokens: 10,
              requestMessageCount: 7,
              priceSource: "unknown",
              predictedCacheState: "cold",
              predictedCacheReason: "summary_transcript",
            },
          ],
        };
      });
      rig = await fixture({ summarizer, child });
      const run = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        tools: [],
        userText: "Continue.",
      });
      expect((await run.execute()).status).toBe("cancelled");
      const c = await rig.repos.turns.findById(run.executionTurnId);
      expect(c?.status).toBe("cancelled");
      expect(await rig.repos.modelResponses.listByTurn(run.executionTurnId)).toMatchObject([
        { requestMessageCount: 7 },
      ]);
      const rows = await rig.repos.modelResponses.listByTurn(run.executionTurnId);
      expect(BigInt(rows[0].millicredits ?? "0")).toBeGreaterThan(0n);
      const debits = await db.select().from(schema.creditTransactions);
      expect(debits.some((row) => row.usageEventId === rows[0].id)).toBe(true);
      if (child)
        expect(
          await rig.repos.executionReports.findByExecution(rig.threadId, run.executionTurnId),
        ).toMatchObject({ outcome: "cancelled", terminalTurnId: run.executionTurnId });
      await rig.gateway.untilGatewayBoundary();
      const before = rig.summarizer.calls[0].requestInHand;
      if (!before) throw new Error("Missing request in hand");
      expectStablePrefix(before, rig.gateway.requests[0]);
      await expect
        .poll(async () => (await rig.repos.turns.listByThread(rig.threadId)).at(-1)?.status)
        .toBe("complete");
      const turns = await rig.repos.turns.listByThread(rig.threadId);
      expect(turns.slice(-3).map((turn) => turn.id)).toEqual([
        run.executionTurnId,
        lateId,
        turns.at(-1)?.id,
      ]);
      expect(await rig.inbox.selectPending(rig.threadId)).toEqual([]);
    });

    it("recompacts with the previous summary leading the summarizer's projection", async () => {
      const rig = await fixture();
      const first = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        tools: [],
        userText: "Continue.",
      });
      expect((await first.execute()).status).toBe("complete");
      const second = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        tools: [],
        userText: "Continue again.",
      });
      expect((await second.execute()).status).toBe("complete");
      expect(rig.summarizer.calls).toHaveLength(2);
      expect(rig.summarizer.calls[1].projection.blocks[0].textContent).toContain(
        "Earlier context.",
      );
      const cuts = (await rig.repos.turns.listByThread(rig.threadId)).filter(
        (turn) => turn.role === "compaction",
      );
      expect(cuts.map((turn) => turn.status)).toEqual(["complete", "complete"]);
      await expect(
        rig.repos.turns.updateStatus(cuts[0].id, {
          status: "complete",
          promptBakeId: crypto.randomUUID(),
        }),
      ).rejects.toThrow();
    });

    it("compacts inside an assistant tool-group suffix with a byte-stable rebuilt successor", async () => {
      let rig: Awaited<ReturnType<typeof fixture>>;
      const result = (id: string, text: string) => ({
        content: [
          { type: "text" as const, text },
          {
            type: "tool_use" as const,
            toolCallId: id,
            toolName: "unavailable_probe_tool",
            input: {},
          },
        ],
        toolCalls: [],
        finishReason: "tool_use" as const,
        usage: { inputTokens: 10000, outputTokens: 10 },
        model: "gpt-4.1-mini",
        provider: "openai",
      });
      const summarizer = scriptedSummarizer(async ({ turnId }) => {
        expect(await rig.runClaim.readRunningTurnId(rig.threadId)).toBe(turnId);
        expect(await rig.runClaim.read(rig.threadId)).toMatchObject({
          kind: "awake",
          phase: "compacting",
        });
        expect(rig.orchestrator.getRunningTurn(rig.threadId)).toMatchObject({
          turnId,
          kind: "compaction",
        });
        return {
          kind: "complete",
          text: "The earlier scene is complete.",
          model: "summary-model",
          modelResponses: [],
        };
      });
      const gateway = scriptedGateway({
        results: [
          result("first-tool", "Earlier scene. ".repeat(1000)),
          result("last-tool", "Latest group."),
          {
            ...result("successor-tool", "Next group."),
            usage: { inputTokens: 100, outputTokens: 10 },
          },
        ],
        onStream: async (call) => {
          if (call === 1) rig.setThreshold(undefined);
          if (call === 2) rig.setThreshold(2500);
          if (call === 3) {
            const latest = (await rig.repos.turns.listByThread(rig.threadId)).at(-1);
            expect(latest?.role).toBe("assistant");
            expect(await rig.runClaim.readRunningTurnId(rig.threadId)).toBe(latest?.id);
            expect(rig.orchestrator.getRunningTurn(rig.threadId)?.kind).toBe("assistant");
          }
        },
      });
      rig = await fixture({ history: "brief history", gateway, summarizer });
      const run = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        tools: [],
        userText: "Continue.",
      });
      expect((await run.execute()).status).toBe("complete");
      const turns = await rig.repos.turns.listByThread(rig.threadId);
      const tail = turns.slice(-3);
      expect(tail.map((turn) => turn.role)).toEqual(["assistant", "compaction", "assistant"]);
      expect(tail[1].metadata).toMatchObject({
        compactedThrough: { turnId: tail[0].id, blockSequence: 2 },
      });
      expect((await rig.repos.blocks.listByTurn(tail[1].id))[0].content).toMatchObject({
        props: { excludedTurnCount: 3 },
      });
      expect(rig.summarizer.calls).toHaveLength(1);
      const request = rig.gateway.requests[2];
      expect(rig.gateway.requests).toHaveLength(4);
      const later = rig.gateway.requests[3];
      expect(later.tools).toEqual(request.tools);
      expect(JSON.stringify(later.messages.slice(0, request.messages.length))).toBe(
        JSON.stringify(request.messages),
      );
      expect(promptBytes({ ...request, promptCacheKey: "<thread-id>" })).toMatchSnapshot(
        "compacted request bytes",
      );
      const thread = await rig.repos.threads.findById(rig.threadId);
      if (!thread) throw new Error("Missing thread");
      const rebuilt = await assembleNextTurnContext({
        thread,
        turns: turns.slice(0, -1),
        blocks: (await rig.repos.blocks.listByThread(rig.threadId)).filter(
          (block) => block.turnId !== tail[2].id,
        ),
        agentRevisions: rig.deps.agentRevisions,
        toolRegistry: rig.deps.toolRegistry,
        baseTools: [],
        gateway: rig.deps.gateway,
        promptBakes: rig.repos.promptBakes,
        workContext: rig.deps.workContext,
      });
      expect(promptBytes(request)).toBe(promptBytes(rebuilt.generateRequest));
    });

    it("settles the paid summary when Stop races the live failure landing", async () => {
      const summarizer = scriptedSummarizer(async ({ turnId }) => ({
        kind: "complete",
        text: "Summary.",
        model: "gpt-4.1-mini",
        modelResponses: [
          {
            id: crypto.randomUUID(),
            turnId,
            sequence: 0,
            provider: "openai",
            model: "gpt-4.1-mini",
            inputTokens: 100,
            outputTokens: 10,
            requestMessageCount: 7,
            predictedCacheState: "cold",
            predictedCacheReason: "summary_transcript",
          },
        ],
      }));
      const rig = await fixture({ summarizer });
      const split = rig.delivery.splitAndContinue;
      let first = true;
      rig.delivery.splitAndContinue = async (input) => {
        if (first) {
          first = false;
          throw new Error("successor commit failed");
        }
        await rig.orchestrator.cancel(rig.threadId, input.currentTurn.id);
        return split(input);
      };
      const run = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        tools: [],
        userText: "Continue.",
      });
      expect((await run.execute()).status).toBe("cancelled");
      expect(await rig.repos.turns.findById(run.executionTurnId)).toMatchObject({
        status: "cancelled",
      });
      const rows = await rig.repos.modelResponses.listByTurn(run.executionTurnId);
      expect(rows).toHaveLength(1);
      expect(BigInt(rows[0].millicredits ?? "0")).toBeGreaterThan(0n);
      const debits = await db.select().from(schema.creditTransactions);
      expect(debits.filter((row) => row.usageEventId === rows[0].id)).toHaveLength(1);
      expect(await rig.inbox.selectPending(rig.threadId)).toEqual([]);
    });

    it.each([
      false,
      true,
    ])("leaves C pending without debiting uncommitted paid rows if failure landing fails (lease read fails=%s)", async (readFails) => {
      const responseId = crypto.randomUUID();
      const summarizer = scriptedSummarizer(async ({ turnId }) => ({
        kind: "complete",
        text: "Summary.",
        model: "gpt-4.1-mini",
        modelResponses: [
          {
            id: responseId,
            turnId,
            sequence: 0,
            provider: "openai",
            model: "gpt-4.1-mini",
            inputTokens: 100,
            outputTokens: 10,
            requestMessageCount: 7,
            predictedCacheState: "cold",
            predictedCacheReason: "summary_transcript",
          },
        ],
      }));
      const rig = await fixture({ summarizer });
      let commits = 0;
      rig.delivery.splitAndContinue = async () => {
        commits++;
        throw new Error("database unavailable");
      };
      const read = rig.runClaim.read;
      rig.runClaim.read = async (threadId) => {
        if (readFails && commits === 2) throw new Error("lease read unavailable");
        return read(threadId);
      };
      const run = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        tools: [],
        userText: "Continue.",
      });
      expect((await run.execute()).status).toBe("failed");
      expect(await rig.repos.turns.findById(run.executionTurnId)).toMatchObject({
        role: "compaction",
        status: "pending",
        promptBakeId: null,
      });
      expect(await rig.repos.modelResponses.listByTurn(run.executionTurnId)).toEqual([]);
      const debits = await db.select().from(schema.creditTransactions);
      expect(debits.some((row) => row.usageEventId === responseId)).toBe(false);
      expect(await rig.inbox.selectPending(rig.threadId)).toHaveLength(1);
      expect(rig.summarizer.calls).toHaveLength(1);
    });

    it("rolls back consumed notices with the successor, then settles the summary on failed C", async () => {
      const port = createDrizzleNoticePort(db);
      let armed = false;
      const notices = {
        ...port,
        async consume(ids: readonly number[]) {
          await port.consume(ids);
          if (armed && ids.length) throw new Error("successor notice commit failed");
        },
      };
      let rig: Awaited<ReturnType<typeof fixture>>;
      const summarizer = scriptedSummarizer(async ({ turnId }) => {
        await port.record({
          kind: "awareness_degraded",
          scope: { kind: "thread", threadId: rig.threadId },
          message: "Refresh context.",
          data: { documentIds: ["chapter-1"], documentNames: ["chapter-1.md"] },
        });
        await rig.send(rig.threadId, "late writer before commit failure");
        armed = true;
        return {
          kind: "complete",
          text: "Earlier context.",
          model: "summary-model",
          modelResponses: [
            {
              id: crypto.randomUUID(),
              turnId,
              sequence: 0,
              provider: "openai",
              model: "gpt-4.1-mini",
              inputTokens: 100,
              outputTokens: 10,
              requestMessageCount: 7,
              priceSource: "unknown",
              predictedCacheState: "cold",
              predictedCacheReason: "summary_transcript",
            },
          ],
        };
      });
      rig = await fixture({ summarizer, notices });
      const treeBudget = createDefaultTreeBudget();
      const run = await rig.orchestrator.prepare({
        treeBudget,
        threadId: rig.threadId,
        tools: [],
        userText: "Continue.",
      });
      expect((await run.execute()).status).toBe("error");
      const c = await rig.repos.turns.findById(run.executionTurnId);
      expect(c).toMatchObject({ status: "error", promptBakeId: null });
      expect(await port.peek(rig.threadId)).toHaveLength(1);
      expect(await rig.repos.modelResponses.listByTurn(run.executionTurnId)).toMatchObject([
        { requestMessageCount: 7 },
      ]);
      const tail = (await rig.repos.turns.listByThread(rig.threadId)).slice(-3);
      expect(tail.map((turn) => [turn.role, turn.status])).toEqual([
        ["compaction", "error"],
        ["user", "complete"],
        ["assistant", "error"],
      ]);
      expect(tail[2].error).toBe("This conversation couldn't be compacted. Try again.");
      expect(await rig.inbox.selectPending(rig.threadId)).toEqual([]);
      expect(rig.summarizer.calls).toHaveLength(1);
      const rows = await rig.repos.modelResponses.listByTurn(run.executionTurnId);
      const debits = await db.select().from(schema.creditTransactions);
      expect(debits.filter((row) => row.usageEventId === rows[0].id)).toHaveLength(1);
      expect(treeBudget.spent.costMillicredits).toBe(Number(rows[0].millicredits));
    });
  });
