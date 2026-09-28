/** Shared PostgreSQL composition for compaction and control boundary contracts. */
import type { Database } from "@meridian/database";
import { executionScenario } from "../../../../test-support/execution-scenario.js";
import { createDrizzleNoticePort } from "../../../notices/adapters/drizzle-notice-port.js";
import type { NoticePort } from "../../../notices/index.js";
import { createDrizzleEventJournalWriter } from "../../../threads/index.js";
import { createDrizzleRunClaim } from "../../adapters/drizzle-run-claim.js";
import { createTestAgentBinding } from "./runtime-fixtures.js";
import { createRuntimeHarness } from "./runtime-harness.js";
import { scriptedSummarizer } from "./scripted-summarizer.js";
import { createTestDrizzleDelivery } from "./test-drizzle-delivery.js";
import { scriptedGateway } from "./test-gateway.js";
export function createCompactionFixture(db: Database) {
  return async function fixture(
    options: {
      notices?: NoticePort;
      history?: string;
      child?: boolean;
      empty?: boolean;
      summarizer?: ReturnType<typeof scriptedSummarizer>;
      gateway?: ReturnType<typeof scriptedGateway>;
    } = {},
  ) {
    const { repos, ids } = await executionScenario(db);
    const threadId = options.child ? ids.child : ids.caller;
    const claim = createDrizzleRunClaim(db, { holderId: "fixture-owner" });
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
    const { createDrizzleCreditLedger } = await import("../../../billing/index.js");
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
            tokenizer: "o200k" as const,
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
    if (!options.empty) {
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
    }
    let active = 0;
    rig.deps.onRunStarted = () => {
      active++;
    };
    rig.deps.onRunSettled = () => {
      active--;
    };
    rig.deps.toolExecutor.getDefinitions = () => [];
    return {
      ...rig,
      repos,
      threadId,
      activeRuns: () => active,
      gateway,
      summarizer,
      ids,
      setThreshold(value: number | undefined) {
        threshold = value;
      },
    };
  };
}
