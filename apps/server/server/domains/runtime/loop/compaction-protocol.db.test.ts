/** Compaction's two commits exercise real inbox, lease, epoch, and journal transactions. */
import { createDefaultTreeBudget } from "@meridian/contracts/spawn";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { executionScenario } from "../../../test-support/execution-scenario.js";
import type { NoticePort } from "../../notices/index.js";
import { createInMemoryEventSink } from "../../observability/index.js";
import { ImageAssetResolutionError } from "../ports/image-asset.js";
import { createTestAgentBinding } from "./__tests__/runtime-fixtures.js";
import { createRuntimeHarness } from "./__tests__/runtime-harness.js";
import { scriptedSummarizer } from "./__tests__/scripted-summarizer.js";
import { createTestDrizzleDelivery } from "./__tests__/test-drizzle-delivery.js";
import { scriptedGateway } from "./__tests__/test-gateway.js";
import { createOrchestrator } from "./orchestrator.js";
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
            predictedCacheReason: "no_response" as const,
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
          predictedCacheReason: "no_response",
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

    it("does not trigger with an unavailable production summarizer even for an explicit threshold", async () => {
      const summarizer = { ...scriptedSummarizer(), enabled: false };
      const rig = await fixture({ summarizer });
      const run = await rig.orchestrator.prepare({
        threadId: rig.threadId,
        tools: [],
        userText: "Continue.",
      });
      expect((await run.execute()).status).toBe("complete");
      expect(summarizer.calls).toHaveLength(0);
      expect(
        (await rig.repos.turns.listByThread(rig.threadId)).some(
          (turn) => turn.role === "compaction",
        ),
      ).toBe(false);
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
              predictedCacheReason: "no_response",
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
        usage: { inputTokens: 1000000, outputTokens: 10 },
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
            predictedCacheReason: "no_response",
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
            predictedCacheReason: "no_response",
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
              predictedCacheReason: "no_response",
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
