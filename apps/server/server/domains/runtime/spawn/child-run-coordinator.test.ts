/**
 * Spawn selection contracts: named roster targets (including primary mode),
 * the generic omitted/empty-agent subagent inheriting caller config, and the
 * pre-create depth refusal. Runs exercise the unified `runChild` entrypoint.
 */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { ReturnResultCapture } from "@meridian/contracts/spawn";
import { createDefaultTreeBudget } from "@meridian/contracts/spawn";
import type { OrchestratorEvent } from "@meridian/contracts/threads";
import { describe, expect, it, vi } from "vitest";
import { InMemoryTransactionOwner } from "../../../shared/in-memory-transaction.js";
import {
  type AgentRevision,
  createInMemoryAgentRevisionStore,
  seedGeneralAgent,
  serializeMarkdownDefinition,
} from "../../packages/index.js";
import { createInMemoryRepositories, type EventJournalWriter } from "../../threads/index.js";
import {
  createInMemoryInbox,
  createInMemoryRunAuthority,
  createInMemoryRunStarter,
  createInMemoryThreadLock,
} from "../adapters/in-memory/loop-ports.js";
import { assembleComposedSystemPrompt } from "../loop/composed-system-prompt.js";
import type { RunTurnPort } from "../loop/run-turn-port.js";
import { createThreadedInbox } from "../loop/threaded-inbox.js";
import { createToolRegistry, resolveAgentThreadTurnContext } from "../tools/index.js";
import { createChildRunCoordinator } from "./child-run-coordinator.js";
import { createChildRunDriver } from "./child-run-driver.js";
import type { SpawnTranscript } from "./spawn-transcript.js";

type RecordedTurn = {
  threadId: ThreadId;
  userText: string;
  assistantTurnId: TurnId;
};

function stubOrchestrator(records: RecordedTurn[]): RunTurnPort {
  let counter = 0;
  return {
    async runTurn(input) {
      counter += 1;
      const assistantTurnId = `assistant-turn-${counter}` as TurnId;
      records.push({
        threadId: input.threadId,
        userText: "userText" in input ? input.userText : "",
        assistantTurnId,
      });
      // return_result settles while the child's event generator runs, after
      // runTurn has already returned the assistant turn id.
      return {
        userTurnId: `user-turn-${counter}` as TurnId,
        assistantTurnId,
        events: (async function* () {
          yield* [] as OrchestratorEvent[];
          await input.returnResultCompleter?.({
            summary: `child report ${counter}`,
          } satisfies ReturnResultCapture);
        })(),
      };
    },
    async finalizeGeneratorFailure() {},
  };
}

async function fixture(options: { orchestrator?: RunTurnPort } = {}) {
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

  const installed = await revisions.installSource({
    coordinate: "test/agents",
    files: {
      "mars.toml": '[package]\nname = "test-agents"\n',
      "agents/critic.md": serializeMarkdownDefinition(
        {
          name: "Critic",
          model: "critic-model",
          mode: "primary",
          tools: { read: "allow", edit: "deny", ask_user: "allow" },
        },
        "You are Critic.",
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
          tools: { read: "allow", edit: "deny" },
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
    tools: { read: "allow", edit: "deny" } as const,
    effort: "high" as const,
  };
  await revisions.bindThread(parent.id, parentRevision.id, parentConfiguration, null);

  const journal: Array<{ type: string; childThreadId?: string }> = [];
  const abortedChildren: string[] = [];
  const turns: RecordedTurn[] = [];
  const runAuthority = createInMemoryRunAuthority();
  const eventWriter: EventJournalWriter = {
    async appendEvent(_threadId, event) {
      journal.push(event as unknown as { type: string; childThreadId?: string });
      return BigInt(journal.length);
    },
  };
  const inbox = createInMemoryInbox();
  const runStarter = createInMemoryRunStarter();
  const threadedInbox = createThreadedInbox({
    inbox,
    threadLock: createInMemoryThreadLock(),
    runStarter,
    schedulePostCommit: (task) => task(),
  });

  const driver = createChildRunDriver({
    orchestrator: options.orchestrator ?? stubOrchestrator(turns),
    repos: {
      threads: repos.threads,
      turns: repos.turns,
      blocks: repos.blocks,
      transaction: repos.transaction,
    },
    eventWriter,
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
    threadedInbox,
    workContextDelivery: { async flushOwned() {} },
    runAuthority,
    billingSpendReader: {
      async getThreadDebitTotal() {
        return "0";
      },
    },
  });
  const coordinator = createChildRunCoordinator({
    driver,
    threadedInbox,
    repos: {
      threads: repos.threads,
      subagentThreads: repos.threads,
      transaction: repos.transaction,
    },
    resolveWorkMembership: async () => "no-work",
    eventWriter,
    agentRevisions: revisions,
    defaultModel: () => "parent-model",
    unavailableReasons: () => [],
    modelUnavailable: (model) =>
      model === "parent-model" ? [] : ["The Agent's configured model is unavailable."],
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
    turns,
    inbox,
    runStarter,
    runAuthority,
    eventWriter,
  };
}

const prompt = "do the thing";
const budget = createDefaultTreeBudget();

function transcriptFor(
  threadId: ThreadId,
  deps: { repos: ReturnType<typeof createInMemoryRepositories>; eventWriter: EventJournalWriter },
): SpawnTranscript {
  return {
    persistence: { repos: deps.repos, eventWriter: deps.eventWriter },
    threadId,
    turnId: "card-turn",
    blockSeqRef: { value: 0 },
    allBlocks: [],
    events: [],
  };
}

describe("ChildRunCoordinator spawn selection", () => {
  it("settle-only completer refuses a second return and never aborts", async () => {
    const { coordinator, abortedChildren } = await fixture();
    const completer = coordinator.createReturnResultCompleter();

    const first = await completer({ summary: "done" });
    expect(first).toEqual({ ok: true });

    const second = await completer({ summary: "again" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.message.length).toBeGreaterThan(0);

    expect(abortedChildren).toEqual([]);
  });

  it("refuses depth 4 before creating a child; depth 3 still spawns", async () => {
    const { coordinator, parent, journal } = await fixture();
    const refused = await coordinator.runChild(
      {
        kind: "spawn",
        parentThread: { ...parent, spawnDepth: 3 },
        parentTurnId: "turn-1" as TurnId,
        agentSlug: "",
        prompt,
        budget,
      },
      { mode: "foreground" },
    );
    expect(refused.status).toBe("error");
    if (refused.status === "error") expect(refused.error.code).toBe("spawn_depth_exceeded");
    expect(journal.some((event) => event.type === "agent.spawn")).toBe(false);

    const allowed = await coordinator.runChild(
      {
        kind: "spawn",
        parentThread: { ...parent, spawnDepth: 2 },
        parentTurnId: "turn-1" as TurnId,
        agentSlug: "",
        prompt,
        budget,
      },
      { mode: "foreground" },
    );
    expect(allowed.status).toBe("completed");
  });

  it("spawns a rostered named target even when it is a primary", async () => {
    const { coordinator, parent, revisions, critic } = await fixture();
    const result = await coordinator.runChild(
      {
        kind: "spawn",
        parentThread: parent,
        parentTurnId: "turn-1" as TurnId,
        agentSlug: "critic",
        prompt,
        budget,
      },
      { mode: "foreground" },
    );
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    const binding = await revisions.readThreadBinding(result.report.threadId);
    expect(binding?.revision?.id).toBe(critic.id);
    expect(binding?.revision?.definition.metadata.name).toBe("Critic");
    expect(binding?.configuration.model).toBe("critic-model");
  });

  it("refuses a slug that is not on the roster without creating a child", async () => {
    const { coordinator, parent, journal } = await fixture();
    const result = await coordinator.runChild(
      {
        kind: "spawn",
        parentThread: parent,
        parentTurnId: "turn-1" as TurnId,
        agentSlug: "writer-helper",
        prompt,
        budget,
      },
      { mode: "foreground" },
    );
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error.code).toBe("spawn_agent_not_allowed");
    expect(journal.some((event) => event.type === "agent.spawn")).toBe(false);
  });

  it("refuses a rostered target that is not model-invocable", async () => {
    const { coordinator, parent } = await fixture();
    const result = await coordinator.runChild(
      {
        kind: "spawn",
        parentThread: parent,
        parentTurnId: "turn-1" as TurnId,
        agentSlug: "hidden",
        prompt,
        budget,
      },
      { mode: "foreground" },
    );
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error.code).toBe("spawn_agent_not_found");
  });

  it("treats omitted and empty agent as a generic child that inherits caller config", async () => {
    const { coordinator, parent, revisions, parentConfiguration } = await fixture();
    for (const agentSlug of [undefined, ""]) {
      const result = await coordinator.runChild(
        {
          kind: "spawn",
          parentThread: parent,
          parentTurnId: "turn-1" as TurnId,
          agentSlug,
          prompt,
          budget,
        },
        { mode: "foreground" },
      );
      expect(result.status).toBe("completed");
      if (result.status !== "completed") continue;
      const binding = await revisions.readThreadBinding(result.report.threadId);
      expect(binding?.revision).toBeNull();
      expect(binding?.configuration.model).toBe("parent-model");
      expect(binding?.configuration.namedTargets).toEqual(parentConfiguration.namedTargets);
      expect(binding?.configuration.tools).toEqual({ read: "allow", edit: "deny" });
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
      tools: { read: "allow", edit: "deny" } as const,
      effort: "high" as const,
    };
    const genericParent = await repos.threads.create({ userId: "user-1", projectId: "project-1" });
    await revisions.bindThread(genericParent.id, general.id, parentConfiguration, null);

    const result = await coordinator.runChild(
      {
        kind: "spawn",
        parentThread: genericParent,
        parentTurnId: "turn-1" as TurnId,
        agentSlug: "",
        prompt,
        budget,
      },
      { mode: "foreground" },
    );
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    const binding = await revisions.readThreadBinding(result.report.threadId);
    expect(binding?.revision).toBeNull();
    expect(binding?.configuration.tools).toEqual(parentConfiguration.tools);
    expect(binding?.configuration.effort).toBe("high");
    expect(binding?.configuration["disallowed-tools"]).toBeUndefined();
  });

  it("allocates cN for primaries and pN for subagents from one project counter", async () => {
    const { coordinator, parent, repos } = await fixture();
    expect(parent.ref).toBe("c1");
    const result = await coordinator.runChild(
      {
        kind: "spawn",
        parentThread: parent,
        parentTurnId: "turn-1" as TurnId,
        agentSlug: "",
        prompt,
        budget,
      },
      { mode: "foreground" },
    );
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.report.handle).toBe("p2");
    const child = await repos.threads.findById(result.report.threadId);
    expect(child?.ref).toBe("p2");
  });

  it("omits spawned children from writer-facing lists while Open by id still works", async () => {
    const { coordinator, parent, repos } = await fixture();
    const result = await coordinator.runChild(
      {
        kind: "spawn",
        parentThread: parent,
        parentTurnId: "turn-1" as TurnId,
        agentSlug: "",
        prompt,
        budget,
      },
      { mode: "foreground" },
    );
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

describe("ChildRunCoordinator invocation overlay", () => {
  it("persists only the provided overlay fields for generic and named children", async () => {
    const { coordinator, parent, revisions, repos } = await fixture();
    const generic = await coordinator.runChild(
      {
        kind: "spawn",
        parentThread: parent,
        parentTurnId: "turn-1" as TurnId,
        agentSlug: "",
        prompt,
        appendSystemPrompt: "Custom child prompt",
        overrides: { effort: "low" },
        budget,
      },
      { mode: "foreground" },
    );
    expect(generic.status).toBe("completed");
    if (generic.status !== "completed") return;
    const genericBinding = await revisions.readThreadBinding(generic.report.threadId);
    expect(genericBinding?.revision).toBeNull();
    expect(genericBinding?.invocationOverlay).toEqual({
      appendSystemPrompt: "Custom child prompt",
      overrides: { effort: "low" },
    });
    expect(genericBinding?.configuration.effort).toBe("low");

    const named = await coordinator.runChild(
      {
        kind: "spawn",
        parentThread: parent,
        parentTurnId: "turn-1" as TurnId,
        agentSlug: "critic",
        prompt,
        appendSystemPrompt: "Custom child prompt",
        overrides: { model: "critic-model" },
        budget,
      },
      { mode: "foreground" },
    );
    expect(named.status).toBe("completed");
    if (named.status !== "completed") return;
    const namedBinding = await revisions.readThreadBinding(named.report.threadId);
    expect(namedBinding?.revision?.id).toBeDefined();
    expect(namedBinding?.invocationOverlay).toEqual({
      appendSystemPrompt: "Custom child prompt",
      overrides: { model: "critic-model" },
    });

    const childThread = await repos.threads.findById(named.report.threadId);
    if (!childThread) throw new Error("Missing spawned child thread");
    const context = await resolveAgentThreadTurnContext({
      thread: childThread,
      agentRevisions: revisions,
      toolRegistry: createToolRegistry(),
      baseTools: undefined,
    });
    const composed = assembleComposedSystemPrompt({
      basePrompt: context.agentBody,
      appendPrompt: context.appendPrompt,
      subagentGuidance: context.subagentGuidance,
    });
    expect(composed).toContain("You are Critic.");
    expect(composed).toContain("Custom child prompt");
  });

  it("rejects an out-of-scope tool grant before creating the child", async () => {
    const { coordinator, revisions, repos, journal } = await fixture();
    const restrictedParent = await repos.threads.create({
      userId: "user-1",
      projectId: "project-1",
    });
    await revisions.bindThread(
      restrictedParent.id,
      null,
      {
        model: "parent-model",
        skills: { load: [], available: [] },
        namedTargets: [],
        tools: { read: "allow", edit: "deny" },
      },
      null,
    );
    const result = await coordinator.runChild(
      {
        kind: "spawn",
        parentThread: restrictedParent,
        parentTurnId: "turn-1" as TurnId,
        agentSlug: "",
        prompt,
        overrides: { tools: { edit: "allow" } },
        budget,
      },
      { mode: "foreground" },
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe("spawn_invocation_authority_denied");
    }
    expect(journal.some((event) => event.type === "agent.spawn")).toBe(false);
  });

  it("rejects patch-invalid overrides before creating a child", async () => {
    const { coordinator, parent, journal } = await fixture();
    const invalidOverrides = [
      { subagents: ["ghost"] },
      { bogus: true },
      { effort: "bananas" },
      { tools: { write: "allow" } },
    ];
    for (const overrides of invalidOverrides) {
      const result = await coordinator.runChild(
        {
          kind: "spawn",
          parentThread: parent,
          parentTurnId: "turn-1" as TurnId,
          agentSlug: "",
          prompt,
          overrides: overrides as never,
          budget,
        },
        { mode: "foreground" },
      );
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe("spawn_invocation_patch_invalid");
      }
    }
    expect(journal.some((event) => event.type === "agent.spawn")).toBe(false);
  });

  it("persists an in-scope named grant when the caller holds the tool", async () => {
    const { coordinator, revisions, repos, critic } = await fixture();
    const writerParent = await repos.threads.create({ userId: "user-1", projectId: "project-1" });
    await revisions.bindThread(
      writerParent.id,
      null,
      {
        model: "parent-model",
        skills: { load: [], available: [] },
        namedTargets: [{ name: "critic", definitionRevisionId: critic.id }],
        tools: { read: "allow", edit: "allow", ask_user: "allow" },
      },
      null,
    );
    const result = await coordinator.runChild(
      {
        kind: "spawn",
        parentThread: writerParent,
        parentTurnId: "turn-1" as TurnId,
        agentSlug: "critic",
        prompt,
        overrides: { tools: { edit: "allow" } },
        budget,
      },
      { mode: "foreground" },
    );
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    const binding = await revisions.readThreadBinding(result.report.threadId);
    expect(binding?.configuration.tools).toEqual({
      read: "allow",
      edit: "allow",
      ask_user: "allow",
    });
  });

  it("rejects an agentless child whose overridden model is unavailable", async () => {
    const { coordinator, parent, journal } = await fixture();
    const result = await coordinator.runChild(
      {
        kind: "spawn",
        parentThread: parent,
        parentTurnId: "turn-1" as TurnId,
        agentSlug: "",
        prompt,
        overrides: { model: "bogus-model" },
        budget,
      },
      { mode: "foreground" },
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe("spawn_agent_unavailable");
    }
    expect(journal.some((event) => event.type === "agent.spawn")).toBe(false);
  });
});

describe("ChildRunCoordinator thread_message", () => {
  it("runs one more turn against the frozen binding", async () => {
    const { coordinator, parent, revisions, turns } = await fixture();
    const spawned = await coordinator.runChild(
      {
        kind: "spawn",
        parentThread: parent,
        parentTurnId: "turn-1" as TurnId,
        agentSlug: "critic",
        prompt,
        appendSystemPrompt: "child guidance",
        budget,
      },
      { mode: "foreground" },
    );
    expect(spawned.status).toBe("completed");
    if (spawned.status !== "completed") return;
    const childId = spawned.report.threadId as ThreadId;
    const childHandle = spawned.report.handle;
    expect(childHandle).toMatch(/^p[1-9]\d*$/);
    const before = await revisions.readThreadBinding(childId);
    expect(before?.revision?.slug).toBe("critic");
    expect(before?.invocationOverlay).toEqual({ appendSystemPrompt: "child guidance" });

    const continued = await coordinator.runChild(
      {
        kind: "message",
        parentThread: parent,
        parentTurnId: "turn-2" as TurnId,
        ref: childHandle,
        prompt: "keep going",
        toolCallId: "call-1",
        budget,
      },
      { mode: "foreground" },
    );
    expect(continued.status).toBe("completed");
    if (continued.status !== "completed") return;
    expect(continued.report.threadId).toBe(childId);
    expect(continued.report.handle).toBe(childHandle);
    expect(continued.report.summary).not.toBe(spawned.report.summary);

    const last = turns[turns.length - 1];
    expect(last?.threadId).toBe(childId);
    expect(last?.userText).toBe("keep going");
    expect(await revisions.readThreadBinding(childId)).toEqual(before);
  });

  it("captures a distinct report per continuation", async () => {
    const { coordinator, parent } = await fixture();
    const spawned = await coordinator.runChild(
      {
        kind: "spawn",
        parentThread: parent,
        parentTurnId: "turn-1" as TurnId,
        agentSlug: "",
        prompt,
        budget,
      },
      { mode: "foreground" },
    );
    if (spawned.status !== "completed") throw new Error("spawn failed");
    const childId = spawned.report.threadId as ThreadId;
    const childHandle = spawned.report.handle;

    const first = await coordinator.runChild(
      {
        kind: "message",
        parentThread: parent,
        parentTurnId: "turn-2" as TurnId,
        ref: childHandle,
        prompt: "first follow-up",
        toolCallId: "call-first",
        budget,
      },
      { mode: "foreground" },
    );
    const second = await coordinator.runChild(
      {
        kind: "message",
        parentThread: parent,
        parentTurnId: "turn-3" as TurnId,
        ref: childHandle,
        prompt: "second follow-up",
        toolCallId: "call-second",
        budget,
      },
      { mode: "foreground" },
    );
    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    if (first.status !== "completed" || second.status !== "completed") return;
    expect(first.report.threadId).toBe(childId);
    expect(second.report.threadId).toBe(childId);
    expect(first.report.summary).not.toBe(second.report.summary);
  });

  it("returns thread_message_target_busy without touching the child lifecycle or events", async () => {
    const { coordinator, parent, repos, journal, runAuthority } = await fixture();
    const spawned = await coordinator.runChild(
      {
        kind: "spawn",
        parentThread: parent,
        parentTurnId: "turn-1" as TurnId,
        agentSlug: "",
        prompt,
        budget,
      },
      { mode: "foreground" },
    );
    if (spawned.status !== "completed") throw new Error("spawn failed");
    const childId = spawned.report.threadId as ThreadId;
    const before = await repos.threads.findById(childId);
    const completions = journal.filter((event) => event.type === "agent.run_completed").length;

    const heldLease = await runAuthority.acquire(childId, "blocking-run");
    expect(heldLease).not.toBeNull();
    try {
      const busy = await coordinator.runChild(
        {
          kind: "message",
          parentThread: parent,
          parentTurnId: "turn-2" as TurnId,
          ref: spawned.report.handle,
          prompt: "again",
          toolCallId: "call-busy",
          budget,
        },
        { mode: "foreground" },
      );
      expect(busy.status).toBe("error");
      if (busy.status === "error") {
        expect(busy.error.code).toBe("thread_message_target_busy");
        // The error reaches the model; it must not carry the child UUID.
        expect(busy.error.message).not.toContain(childId);
        expect(busy.error.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
      }
    } finally {
      if (heldLease) await runAuthority.release(heldLease);
    }

    const after = await repos.threads.findById(childId);
    expect(after?.spawnStatus).toBe(before?.spawnStatus);
    expect(after?.spawnResult).toEqual(before?.spawnResult);
    expect(journal.filter((event) => event.type === "agent.run_completed").length).toBe(
      completions,
    );
  });

  it("returns thread_message_target_unavailable when the child has no retained binding", async () => {
    const { coordinator, parent, repos, revisions } = await fixture();
    const child = await repos.threads.createSubagent({
      userId: parent.userId,
      projectId: parent.projectId,
      parentThreadId: parent.id as ThreadId,
      rootThreadId: parent.id as ThreadId,
      spawnDepth: 1,
    });
    expect(await revisions.readThreadBinding(child.id)).toBeUndefined();

    const result = await coordinator.runChild(
      {
        kind: "message",
        parentThread: parent,
        parentTurnId: "turn-2" as TurnId,
        ref: child.ref ?? "",
        prompt: "keep going",
        toolCallId: "call-unavailable",
        budget,
      },
      { mode: "foreground" },
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe("thread_message_target_unavailable");
    }
  });

  it("persists the running card with the pre-minted childThreadId", async () => {
    const { coordinator, parent, repos, eventWriter } = await fixture();
    const transcript = transcriptFor(parent.id as ThreadId, { repos, eventWriter });
    const spawned = await coordinator.runChild(
      {
        kind: "spawn",
        parentThread: parent,
        parentTurnId: "turn-1" as TurnId,
        agentSlug: "",
        prompt,
        budget,
      },
      { mode: "foreground", transcript },
    );
    expect(spawned.status).toBe("completed");
    if (spawned.status !== "completed") return;

    const customBlocks = transcript.events.flatMap((event) =>
      event.type === "block.upserted" && event.block.blockType === "custom" ? [event.block] : [],
    );
    expect(customBlocks.length).toBe(2);
    expect(customBlocks[0]?.content).toMatchObject({
      kind: "helper-result",
      props: { status: "running", childThreadId: spawned.report.threadId },
    });
    expect(customBlocks[1]?.content).toMatchObject({
      kind: "helper-result",
      props: { status: "completed", childThreadId: spawned.report.threadId },
    });
  });

  it("enqueues one agent steer for a background message and wakes the target", async () => {
    const { coordinator, parent, inbox, runStarter, turns } = await fixture();
    const spawned = await coordinator.runChild(
      {
        kind: "spawn",
        parentThread: parent,
        parentTurnId: "turn-1" as TurnId,
        agentSlug: "critic",
        prompt,
        budget,
      },
      { mode: "foreground" },
    );
    if (spawned.status !== "completed") throw new Error("spawn failed");
    const childId = spawned.report.threadId as ThreadId;
    const turnsBefore = turns.length;

    const background = await coordinator.runChild(
      {
        kind: "message",
        parentThread: parent,
        parentTurnId: "turn-2" as TurnId,
        ref: spawned.report.handle,
        prompt: "run in the background",
        toolCallId: "call-bg",
        budget,
      },
      { mode: "background" },
    );
    expect(background.status).toBe("background");
    if (background.status !== "background") return;
    expect(background.handle).toBe(spawned.report.handle);

    const pending = await inbox.claimPending(childId);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      threadId: childId,
      intent: "steer",
      provenance: { kind: "agent", threadId: parent.id },
      body: { kind: "text", text: "run in the background" },
      idempotencyKey: "thread-message:call-bg",
    });
    // A steer wakes the (asleep) target; the caller drives nothing here.
    expect(runStarter.started).toContain(childId);
    expect(turns.length).toBe(turnsBefore);
  });

  it("does not enqueue anything for a foreground message", async () => {
    const { coordinator, parent, runStarter } = await fixture();
    const spawned = await coordinator.runChild(
      {
        kind: "spawn",
        parentThread: parent,
        parentTurnId: "turn-1" as TurnId,
        agentSlug: "",
        prompt,
        budget,
      },
      { mode: "foreground" },
    );
    if (spawned.status !== "completed") throw new Error("spawn failed");

    const continued = await coordinator.runChild(
      {
        kind: "message",
        parentThread: parent,
        parentTurnId: "turn-2" as TurnId,
        ref: spawned.report.handle,
        prompt: "keep going",
        toolCallId: "call-fg",
        budget,
      },
      { mode: "foreground" },
    );
    expect(continued.status).toBe("completed");
    // Foreground drives in-process; it never enqueues a steer on the target.
    expect(runStarter.started).not.toContain(spawned.report.threadId);
  });

  it("records the background report durably when return_result settles, before the run ends", async () => {
    const orchestrator: RunTurnPort = {
      async runTurn(input) {
        return {
          userTurnId: "user-turn-1" as TurnId,
          assistantTurnId: "assistant-turn-1" as TurnId,
          events: (async function* () {
            yield* [] as OrchestratorEvent[];
            await input.returnResultCompleter?.({
              summary: "durable report",
              payload: { saved: true },
            } satisfies ReturnResultCapture);
            // A crash after return_result must not erase the obligation.
            throw new Error("run died after return_result");
          })(),
        };
      },
      async finalizeGeneratorFailure() {},
    };
    const { coordinator, parent, inbox } = await fixture({ orchestrator });

    const background = await coordinator.runChild(
      {
        kind: "spawn",
        parentThread: parent,
        parentTurnId: "turn-1" as TurnId,
        agentSlug: "",
        prompt,
        budget,
      },
      { mode: "background" },
    );
    expect(background.status).toBe("background");

    await vi.waitFor(async () => {
      expect(await inbox.claimPending(parent.id)).toHaveLength(1);
    });
    const [report] = await inbox.claimPending(parent.id);
    expect(report).toMatchObject({
      intent: "steer",
      provenance: { kind: "child", reportId: "assistant-turn-1" },
      body: { kind: "report", text: "durable report", payload: { saved: true } },
      idempotencyKey: "child-report:assistant-turn-1",
    });
  });

  it("does not rewrite the child's stored report when a thread_message run fails", async () => {
    let calls = 0;
    const orchestrator: RunTurnPort = {
      async runTurn(input) {
        calls += 1;
        if (calls === 1) {
          return {
            userTurnId: "user-turn-1" as TurnId,
            assistantTurnId: "assistant-turn-1" as TurnId,
            events: (async function* () {
              yield* [] as OrchestratorEvent[];
              await input.returnResultCompleter?.({
                summary: "first report",
              } satisfies ReturnResultCapture);
            })(),
          };
        }
        throw new Error("continue run crashed");
      },
      async finalizeGeneratorFailure() {},
    };
    const { coordinator, parent, repos } = await fixture({ orchestrator });

    const spawned = await coordinator.runChild(
      {
        kind: "spawn",
        parentThread: parent,
        parentTurnId: "turn-1" as TurnId,
        agentSlug: "",
        prompt,
        budget,
      },
      { mode: "foreground" },
    );
    if (spawned.status !== "completed") throw new Error("spawn failed");
    const childId = spawned.report.threadId as ThreadId;
    const before = await repos.threads.findById(childId);
    expect(before?.spawnStatus).toBe("succeeded");

    const continued = await coordinator.runChild(
      {
        kind: "message",
        parentThread: parent,
        parentTurnId: "turn-2" as TurnId,
        ref: spawned.report.handle,
        prompt: "again",
        toolCallId: "call-fail",
        budget,
      },
      { mode: "foreground" },
    );
    expect(continued.status).toBe("error");

    const after = await repos.threads.findById(childId);
    expect(after?.spawnStatus).toBe("succeeded");
    expect(after?.spawnResult).toEqual(before?.spawnResult);
  });

  it("returns thread_message_target_not_found for a malformed ref", async () => {
    const { coordinator, parent } = await fixture();
    const result = await coordinator.runChild(
      {
        kind: "message",
        parentThread: parent,
        parentTurnId: "turn-1" as TurnId,
        ref: "not-a-handle",
        prompt,
        toolCallId: "call-bad-ref",
        budget,
      },
      { mode: "foreground" },
    );
    expect(result.status).toBe("error");
    if (result.status === "error")
      expect(result.error.code).toBe("thread_message_target_not_found");
  });
});
