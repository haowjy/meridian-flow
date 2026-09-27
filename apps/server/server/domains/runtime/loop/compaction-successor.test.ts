/** The compaction event and its durable divider report the same measured requests. */
import { createDefaultTreeBudget } from "@meridian/contracts/spawn";
import { describe, expect, it } from "vitest";
import { executionScenario } from "../../../test-support/execution-scenario.js";
import { createInMemoryEventJournalWriter } from "../../threads/index.js";
import { createTestAgentBinding } from "./__tests__/runtime-fixtures.js";
import { createRuntimeHarness } from "./__tests__/runtime-harness.js";
import { scriptedSummarizer } from "./__tests__/scripted-summarizer.js";
import { scriptedGateway } from "./__tests__/test-gateway.js";
import { estimateRequestTokens } from "./compaction/estimate.js";

describe("compaction successor measurements", () => {
  it("keeps the compacted event and durable divider props aligned", async () => {
    const scenario = await executionScenario();
    const { repos, ids } = scenario;
    const eventWriter = createInMemoryEventJournalWriter();
    const gatewayFixture = scriptedGateway();
    const gateway = {
      ...gatewayFixture,
      listModels: () => [
        {
          id: "gpt-4.1-mini",
          provider: "openai",
          displayName: "Fixture",
          contextWindow: 128_000,
          maxOutputTokens: 100,
          promptCache: { kind: "automatic" as const, ttlMs: 60_000 },
          capabilities: new Set<import("../gateway/index.js").Capability>(["image_input"]),
        },
      ],
    };
    const binding = createTestAgentBinding("gpt-4.1-mini", "Write the next chapter.", () => [
      ids.caller,
    ]);
    const readBinding = binding.readThreadBinding;
    binding.readThreadBinding = async (threadId) => {
      const result = await readBinding(threadId);
      if (result?.revision) result.revision.definition.metadata.autocompact = 2_500;
      return result;
    };
    const summarizer = scriptedSummarizer();
    const harness = createRuntimeHarness({
      repos,
      eventWriter,
      gateway,
      agentRevisions: binding,
      summarizer,
      boundThreads: () => [ids.caller],
    });
    await harness.creditLedger.grant({
      userId: ids.user,
      source: "manual",
      amountMillicredits: "1000000000",
      reason: "compaction telemetry test",
    });

    const contextTurn = await repos.turns.create({
      threadId: ids.caller,
      prevTurnId: ids.callerTurn,
      role: "user",
      origin: "writer",
      status: "complete",
    });
    await repos.blocks.create({
      turnId: contextTurn.id,
      blockType: "text",
      sequence: 0,
      content: "Earlier xianxia chapter context. ".repeat(1_500),
      textContent: "Earlier xianxia chapter context. ".repeat(1_500),
      status: "complete",
    });
    const answerTurn = await repos.turns.create({
      threadId: ids.caller,
      prevTurnId: contextTurn.id,
      role: "assistant",
      origin: "assistant",
      status: "complete",
    });
    await repos.blocks.create({
      turnId: answerTurn.id,
      blockType: "text",
      sequence: 0,
      content: "The disciple has not claimed the token.",
      textContent: "The disciple has not claimed the token.",
      status: "complete",
    });

    const run = await harness.orchestrator.prepare({
      threadId: ids.caller,
      treeBudget: createDefaultTreeBudget(),
      tools: [],
      userText: "Continue the chapter.",
    });
    expect((await run.execute()).status).toBe("complete");

    const compacted = (await eventWriter.listByType(ids.caller, "context.compacted"))[0]?.payload;
    expect(compacted?.type).toBe("context.compacted");
    if (compacted?.type !== "context.compacted") throw new Error("Missing compaction event");

    const compactionTurn = await repos.turns.findById(compacted.compactionTurnId);
    expect(compactionTurn?.role).toBe("compaction");
    const [divider] = await repos.blocks.listByTurn(compacted.compactionTurnId);
    expect(divider?.content).toMatchObject({
      kind: "compaction",
      props: {
        tokensBefore: compacted.tokensBefore,
        tokensAfter: compacted.tokensAfter,
      },
    });

    const requestInHand = summarizer.calls[0]?.requestInHand;
    expect(requestInHand).toBeTruthy();
    expect(compacted.tokensBefore).toBe(
      estimateRequestTokens({
        request: requestInHand as import("../gateway/index.js").GenerateRequest,
        baseline: null,
      }),
    );
    const successorRequest = gatewayFixture.requests[0];
    expect(successorRequest).toBeDefined();
    if (!successorRequest) throw new Error("Missing assembled successor request");
    expect(compacted.tokensAfter).toBe(
      estimateRequestTokens({ request: successorRequest, baseline: null }),
    );
  });
});
