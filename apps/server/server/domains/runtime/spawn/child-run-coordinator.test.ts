/**
 * Spawn selection contracts: named roster targets (including primary mode),
 * the generic omitted/empty-agent helper inheriting caller config, and the
 * pre-create depth refusal.
 */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { ReturnResultCapture } from "@meridian/contracts/spawn";
import { createDefaultTreeBudget } from "@meridian/contracts/spawn";
import { describe, expect, it } from "vitest";
import { InMemoryTransactionOwner } from "../../../shared/in-memory-transaction.js";
import {
  type AgentRevision,
  createInMemoryAgentRevisionStore,
  seedGeneralAgent,
  serializeMarkdownDefinition,
} from "../../packages/index.js";
import { createInMemoryRepositories, type EventJournalWriter } from "../../threads/index.js";
import type { RunTurnPort } from "../loop/run-turn-port.js";
import { createInMemoryThreadRunOwnership } from "../loop/thread-run-ownership.js";
import { createChildRunCoordinator } from "./child-run-coordinator.js";

function stubOrchestrator(): RunTurnPort {
  return {
    async runTurn(input) {
      await input.returnResultCompleter?.({
        summary: "child report",
      } satisfies ReturnResultCapture);
      return {
        userTurnId: "user-turn" as TurnId,
        assistantTurnId: "assistant-turn" as TurnId,
        events: (async function* () {})(),
      };
    },
    async finalizeGeneratorFailure() {},
  };
}

async function fixture() {
  const transactionOwner = new InMemoryTransactionOwner();
  let repos: ReturnType<typeof createInMemoryRepositories>;
  const revisions = createInMemoryAgentRevisionStore({
    transactionOwner,
    threadExists: async (id) => Boolean(await repos.threads.findProjectIdByIdIncludingDeleted(id)),
  });
  repos = createInMemoryRepositories({
    transactionOwner,
    boundAgent: (id) => revisions.boundAgent(id),
  });

  await seedGeneralAgent(revisions, "general-model");
  const generalEntry = await revisions.readCatalogEntry(null, "general");
  if (!generalEntry) throw new Error("Missing General");
  const general = await revisions.readRevision(generalEntry.selectedRevisionId);
  if (!general) throw new Error("Missing General revision");

  const installed = await revisions.installSource({
    coordinate: "test/agents",
    files: {
      "mars.toml": '[package]\nname = "test-agents"\n',
      "agents/critic.md": serializeMarkdownDefinition(
        { name: "Critic", model: "critic-model", mode: "primary" },
        "",
      ),
      "agents/hidden.md": serializeMarkdownDefinition(
        { name: "Hidden", model: "hidden-model", "model-invocable": false },
        "",
      ),
    },
    dependencies: {},
  });
  const critic = installed.definitions.find((entry) => entry.slug === "critic");
  const hidden = installed.definitions.find((entry) => entry.slug === "hidden");
  if (!critic || !hidden) throw new Error("Missing installed test agents");

  const parentInstalled = await revisions.installSource({
    coordinate: "test/parent",
    files: {
      "mars.toml": '[package]\nname = "test-parent"\n',
      "agents/parent.md": serializeMarkdownDefinition(
        {
          name: "Parent",
          model: "parent-model",
          effort: "high",
          tools: { read: "allow", write: "deny" },
        },
        "",
      ),
    },
    dependencies: {},
  });
  const parentRevision = parentInstalled.definitions[0];
  if (!parentRevision) throw new Error("Missing parent revision");

  const parent = await repos.threads.create({ userId: "user-1", projectId: "project-1" });
  const namedTargets = [
    { name: "critic", definitionRevisionId: critic.id },
    { name: "hidden", definitionRevisionId: hidden.id },
  ];
  const parentConfiguration = {
    model: "parent-model",
    skills: { load: [], available: [] },
    namedTargets,
    tools: { read: "allow", write: "deny" } as const,
    effort: "high" as const,
  };
  await revisions.bindThread(parent.id, parentRevision.id, parentConfiguration);

  const journal: Array<{ type: string; childThreadId?: string }> = [];
  const abortedChildren: string[] = [];
  const eventWriter: EventJournalWriter = {
    async appendEvent(_threadId, event) {
      journal.push(event as unknown as { type: string; childThreadId?: string });
      return BigInt(journal.length);
    },
  };

  const coordinator = createChildRunCoordinator({
    orchestrator: stubOrchestrator(),
    repos: {
      threads: repos.threads,
      subagentThreads: repos.threads,
      turns: repos.turns,
      blocks: repos.blocks,
      transaction: repos.transaction,
      threadWorks: repos.threadWorks,
    },
    resolveWorkMembership: async () => "no-work",
    eventWriter,
    agentRevisions: revisions,
    defaultModel: () => "parent-model",
    genericBaseline: async () => general,
    unavailableReasons: () => [],
    childRunRegistry: {
      registerChild() {},
      registerBackgroundChild() {},
      unregisterChild() {},
      markChildTurn() {},
      abortChild(childThreadId) {
        abortedChildren.push(childThreadId as string);
      },
      abortChildrenOf() {},
    },
    helperResultDelivery: {
      async deliverOrQueue() {},
      async flush() {},
      markRunning() {},
      async markIdleAndFlush() {},
    },
    workContextDelivery: { async flushOwned() {} },
    runOwnership: createInMemoryThreadRunOwnership(),
    billingSpendReader: {
      async getThreadDebitTotal() {
        return "0";
      },
    },
  });

  return {
    coordinator,
    revisions,
    repos,
    parent,
    parentConfiguration,
    critic: critic as AgentRevision,
    journal,
    abortedChildren,
  };
}

const prompt = "do the thing";
const budget = createDefaultTreeBudget();

describe("ChildRunCoordinator spawn selection", () => {
  it("records one report without aborting; a second return is refused", async () => {
    const { coordinator, abortedChildren } = await fixture();
    const completer = coordinator.createReturnResultCompleter("child-thread" as ThreadId);

    const first = await completer({ summary: "done" });
    expect(first).toEqual({ ok: true });

    const second = await completer({ summary: "again" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.message.length).toBeGreaterThan(0);

    expect(abortedChildren).toEqual([]);
  });

  it("settle-only completer records one report without capturing for driveChild", async () => {
    const { coordinator } = await fixture();
    const completer = coordinator.createReturnResultCompleter("child-thread" as ThreadId, {
      capture: false,
    });

    expect(await completer({ summary: "done" })).toEqual({ ok: true });
    const second = await completer({ summary: "again" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.message.length).toBeGreaterThan(0);
  });

  it("refuses depth 4 before creating a child; depth 3 still spawns", async () => {
    const { coordinator, parent, journal } = await fixture();
    const refused = await coordinator.spawnChild({
      parentThread: { ...parent, spawnDepth: 3 },
      parentTurnId: "turn-1" as TurnId,
      agentSlug: "",
      prompt,
      budget,
    });
    expect(refused.status).toBe("error");
    if (refused.status === "error") expect(refused.error.code).toBe("spawn_depth_exceeded");
    expect(journal.some((event) => event.type === "agent.spawn")).toBe(false);

    const allowed = await coordinator.spawnChild({
      parentThread: { ...parent, spawnDepth: 2 },
      parentTurnId: "turn-1" as TurnId,
      agentSlug: "",
      prompt,
      budget,
    });
    expect(allowed.status).toBe("completed");
  });

  it("spawns a rostered named target even when it is a primary", async () => {
    const { coordinator, parent, revisions, critic } = await fixture();
    const result = await coordinator.spawnChild({
      parentThread: parent,
      parentTurnId: "turn-1" as TurnId,
      agentSlug: "critic",
      prompt,
      budget,
    });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    const binding = await revisions.readThreadBinding(result.report.threadId);
    expect(binding?.id).toBe(critic.id);
    expect(binding?.definition.metadata.name).toBe("Critic");
    expect(binding?.configuration.model).toBe("critic-model");
  });

  it("refuses a slug that is not on the roster without creating a child", async () => {
    const { coordinator, parent, journal } = await fixture();
    const result = await coordinator.spawnChild({
      parentThread: parent,
      parentTurnId: "turn-1" as TurnId,
      agentSlug: "writer-helper",
      prompt,
      budget,
    });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error.code).toBe("spawn_agent_not_allowed");
    expect(journal.some((event) => event.type === "agent.spawn")).toBe(false);
  });

  it("refuses a rostered target that is not model-invocable", async () => {
    const { coordinator, parent } = await fixture();
    const result = await coordinator.spawnChild({
      parentThread: parent,
      parentTurnId: "turn-1" as TurnId,
      agentSlug: "hidden",
      prompt,
      budget,
    });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error.code).toBe("spawn_agent_not_found");
  });

  it("treats omitted and empty agent as a generic child that inherits caller config", async () => {
    const { coordinator, parent, revisions, parentConfiguration } = await fixture();
    for (const agentSlug of [undefined, ""]) {
      const result = await coordinator.spawnChild({
        parentThread: parent,
        parentTurnId: "turn-1" as TurnId,
        agentSlug,
        prompt,
        budget,
      });
      expect(result.status).toBe("completed");
      if (result.status !== "completed") continue;
      const binding = await revisions.readThreadBinding(result.report.threadId);
      expect(binding?.definition.metadata.name).toBe("General");
      expect(binding?.configuration.model).toBe("parent-model");
      expect(binding?.configuration.namedTargets).toEqual(parentConfiguration.namedTargets);
      expect(binding?.configuration.tools).toEqual({ read: "allow", write: "deny" });
      expect(binding?.configuration.effort).toBe("high");
    }
  });

  it("propagates a generic parent's inherited execution to its generic child", async () => {
    const { coordinator, revisions, repos } = await fixture();
    const generalEntry = await revisions.readCatalogEntry(null, "general");
    const general = generalEntry && (await revisions.readRevision(generalEntry.selectedRevisionId));
    if (!general) throw new Error("Missing General revision");

    const parentConfiguration = {
      model: "parent-model",
      skills: { load: [], available: [] },
      namedTargets: [] as Array<{ name: string; definitionRevisionId: string }>,
      tools: { read: "allow", write: "deny", edit: "deny" } as const,
      effort: "high" as const,
    };
    const genericParent = await repos.threads.create({ userId: "user-1", projectId: "project-1" });
    await revisions.bindThread(genericParent.id, general.id, parentConfiguration);

    const result = await coordinator.spawnChild({
      parentThread: genericParent,
      parentTurnId: "turn-1" as TurnId,
      agentSlug: "",
      prompt,
      budget,
    });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    const binding = await revisions.readThreadBinding(result.report.threadId);
    expect(binding?.definition.metadata.name).toBe("General");
    expect(binding?.configuration.tools).toEqual(parentConfiguration.tools);
    expect(binding?.configuration.effort).toBe("high");
    expect(binding?.configuration["disallowed-tools"]).toBeUndefined();
  });

  it("omits spawned children from writer-facing lists while Open by id still works", async () => {
    const { coordinator, parent, repos } = await fixture();
    const result = await coordinator.spawnChild({
      parentThread: parent,
      parentTurnId: "turn-1" as TurnId,
      agentSlug: "",
      prompt,
      budget,
    });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    const childId = result.report.threadId;
    expect((await repos.threads.listByProject(parent.projectId)).map((row) => row.id)).toEqual([
      parent.id,
    ]);
    const home = await repos.homeFeed.queryPage({
      projectId: parent.projectId,
      userId: parent.userId,
      after: null,
      recentLimit: 10,
      includeFeatured: true,
    });
    expect(home.continueChat?.id).toBe(parent.id);
    expect(home.recent.map((item) => item.id)).not.toContain(childId);
    expect(home.favorites.map((item) => item.id)).not.toContain(childId);
    await expect(repos.threads.findById(childId)).resolves.toMatchObject({
      id: childId,
      kind: "subagent",
    });
  });
});
