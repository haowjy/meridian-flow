/**
 * Spawn selection contracts: named roster targets (including primary mode),
 * the generic omitted/empty-agent subagent inheriting caller config, and the
 * pre-create depth refusal. Runs exercise the unified `runChild` entrypoint.
 */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { createDefaultTreeBudget } from "@meridian/contracts/spawn";
import type { OrchestratorEvent } from "@meridian/contracts/threads";
import { describe, expect, it, vi } from "vitest";
import { InMemoryTransactionOwner } from "../../../shared/in-memory-transaction.js";
import { createInMemoryEventSink } from "../../observability/index.js";
import {
  type AgentRevision,
  createInMemoryAgentRevisionStore,
  seedGeneralAgent,
  serializeMarkdownDefinition,
} from "../../packages/index.js";
import {
  createInMemoryRepositories,
  type EventJournalWriter,
  readThreadActivity,
  TurnStartConflictError,
} from "../../threads/index.js";
import {
  createInMemoryInbox,
  createInMemoryRunClaim,
  createInMemoryRunStarter,
  createInMemoryThreadLock,
} from "../adapters/in-memory/loop-ports.js";
import { createRuntimeHarness } from "../loop/__tests__/runtime-harness.js";
import { assembleComposedSystemPrompt } from "../loop/composed-system-prompt.js";
import type { RunTurnPort } from "../loop/run-turn-port.js";
import { createToolRegistry, resolveAgentThreadTurnContext } from "../tools/index.js";
import { createChildRunCoordinator } from "./child-run-coordinator.js";
import { createChildRunDriver } from "./child-run-driver.js";
import { createReportPublisher } from "./report-publisher.js";
import type { SpawnTranscript } from "./spawn-transcript.js";

type RecordedTurn = {
  threadId: ThreadId;
  userText: string;
  assistantTurnId: TurnId;
};

function stubOrchestrator(
  records: RecordedTurn[],
  repos: ReturnType<typeof createInMemoryRepositories>,
  authority = createInMemoryRunClaim(),
): RunTurnPort {
  let counter = 0;
  return {
    async prepare(input) {
      const lease = await authority.startExecution(input.threadId, crypto.randomUUID());
      if (!lease) throw new TurnStartConflictError(input.threadId, "already_running");
      counter += 1;
      const assistantTurnId = `assistant-turn-${counter}` as TurnId;
      records.push({
        threadId: input.threadId,
        userText: "userText" in input ? input.userText : "",
        assistantTurnId,
      });
      const userTurn = await repos.turns.create({
        threadId: input.threadId,
        role: "user",
        // The child's seed turn is the spawning caller's prompt, not a writer send.
        origin: "system",
        status: "complete",
        prevTurnId: (await repos.threads.findById(input.threadId))?.activeLeafTurnId ?? null,
      });
      const assistant = await repos.turns.create({
        id: assistantTurnId,
        threadId: input.threadId,
        role: "assistant",
        origin: "assistant",
        status: "streaming",
        prevTurnId: userTurn.id,
      });
      const child = await repos.threads.findById(input.threadId);
      if (!child?.ref) throw new Error("missing child handle");
      await repos.executionReports.admit({
        childThreadId: input.threadId,
        assistantTurnId,
        handle: child.ref,
        ...(input.executionReport?.correlation ?? {
          origin: "thread_run" as const,
          deliveryMode: "none" as const,
          callerThreadId: null,
          callerTurnId: null,
          toolCallId: null,
          cardBlockId: null,
        }),
      });
      return {
        userTurnId: userTurn.id,
        assistantTurnId,
        runId: assistantTurnId,
        resumeAfterSeq: "0",
        snapshotFloorNextSeq: "1",
        execute: async () => {
          await repos.executionReports.captureOnce(input.threadId, assistantTurnId, "return", {
            summary: `child report ${counter}`,
          });
          await repos.executionReports.finalizeOnce({
            childThreadId: input.threadId,
            assistantTurnId,
            outcome: "succeeded",
            reason: null,
            source: "return_result",
            summary: `child report ${counter}`,
            costMillicredits: 0,
          });
          if (input.executionReport?.correlation.origin === "spawn") {
            await repos.threads.updateSpawnLifecycle(input.threadId, { spawnStatus: "succeeded" });
          }
          await authority.release(lease);
          return { status: "complete", turn: assistant };
        },
      };
    },
  };
}

async function fixture(
  options: {
    orchestrator?:
      | RunTurnPort
      | ((repos: ReturnType<typeof createInMemoryRepositories>) => RunTurnPort);
    eventWriter?: EventJournalWriter;
  } = {},
) {
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
          tools: { edit: "deny", ask_user: "allow" },
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
          tools: { edit: "deny" },
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
    tools: { edit: "deny" } as const,
    effort: "high" as const,
  };
  await revisions.bindThread(parent.id, parentRevision.id, parentConfiguration, null);

  const journal: Array<{ threadId: string; type: string; childThreadId?: string }> = [];
  const abortedChildren: string[] = [];
  const turns: RecordedTurn[] = [];
  const runClaim = createInMemoryRunClaim();
  const eventWriter: EventJournalWriter = options.eventWriter ?? {
    async appendEvent(threadId, event) {
      journal.push({
        threadId,
        ...(event as unknown as { type: string; childThreadId?: string }),
      });
      return BigInt(journal.length);
    },
  };
  const eventSink = createInMemoryEventSink();
  const readActivity = (threadId: ThreadId) =>
    readThreadActivity({ threads: repos.threads, statusReader: runClaim }, threadId);
  const inbox = createInMemoryInbox();
  const runStarter = createInMemoryRunStarter();
  const delivery = createRuntimeHarness({
    repos,
    eventWriter,
    runClaim,
    inbox,
    threadLock: createInMemoryThreadLock(),
    runStarter,
    schedulePostCommit: (task) => task(),
  }).delivery;
  const publisher = createReportPublisher({ repos, eventWriter, delivery, eventSink });

  const driver = createChildRunDriver({
    orchestrator:
      typeof options.orchestrator === "function"
        ? options.orchestrator(repos)
        : (options.orchestrator ?? stubOrchestrator(turns, repos, runClaim)),
    repos: { executionReports: repos.executionReports },
    eventWriter,
    readActivity,
    publisher,
    eventSink,
  });
  const coreCoordinator = createChildRunCoordinator({
    driver,
    delivery,
    repos: {
      threads: repos.threads,
      subagentThreads: repos.threads,
      transaction: repos.transaction,
    },
    resolveWorkMembership: async () => "no-work",
    eventWriter,
    readActivity,
    agentRevisions: revisions,
    defaultModel: () => "parent-model",
    unavailableReasons: () => [],
    modelUnavailable: (model) =>
      model === "parent-model" ? [] : ["The Agent's configured model is unavailable."],
    eventSink,
  });
  let invocation = 0;
  const coordinator = {
    ...coreCoordinator,
    async runChild(
      request: Parameters<typeof coreCoordinator.runChild>[0],
      options: Parameters<typeof coreCoordinator.runChild>[1],
    ) {
      if (request.kind === "message" && options.mode === "background") {
        return coreCoordinator.runChild(request, options);
      }
      if (!(await repos.turns.findById(request.parentTurnId))) {
        const thread = await repos.threads.findById(request.parentThread.id);
        await repos.turns.create({
          id: request.parentTurnId,
          threadId: request.parentThread.id,
          role: "assistant",
          origin: "assistant",
          status: "complete",
          prevTurnId: thread?.activeLeafTurnId ?? null,
        });
      }
      invocation += 1;
      return coreCoordinator.runChild(
        {
          ...request,
          reportCorrelation: request.reportCorrelation ?? {
            callerThreadId: request.parentThread.id,
            callerTurnId: request.parentTurnId,
            toolCallId:
              request.kind === "message" ? request.toolCallId : `test-invocation-${invocation}`,
            cardBlockId: null,
            origin: request.kind === "spawn" ? "spawn" : "foreground_message",
            deliveryMode: options.mode === "background" ? "background_notification" : "direct",
          },
        },
        options,
      );
    },
  };

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
    runClaim,
    eventWriter,
    eventSink,
  };
}

const prompt = "do the thing";
const budget = createDefaultTreeBudget();

function transcriptFor(
  threadId: ThreadId,
  deps: { repos: ReturnType<typeof createInMemoryRepositories>; eventWriter: EventJournalWriter },
  turnId = "turn-1",
): SpawnTranscript & { journal: OrchestratorEvent[] } {
  const journal: OrchestratorEvent[] = [];
  return {
    persistence: {
      repos: deps.repos,
      eventWriter: {
        async appendEvent(id, event) {
          const seq = await deps.eventWriter.appendEvent(id, event);
          journal.push(event);
          return seq;
        },
      },
    },
    threadId,
    turnId,
    blockSeqRef: { value: 0 },
    allBlocks: [],
    journal,
  };
}

describe("ChildRunCoordinator spawn selection", () => {
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
      expect(binding?.configuration.tools).toEqual({ edit: "deny" });
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
      tools: { edit: "deny" } as const,
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
    const home = await repos.chatFeed.queryPage({
      projectId: parent.projectId,
      userId: parent.userId,
      after: null,
      limit: 10,
      favorite: false,
      search: null,
    });
    expect(home[0]?.id).toBe(parent.id);
    expect(home.map((item) => item.id)).not.toContain(childId);
    expect(home.map((item) => item.id)).not.toContain(childId);
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
        tools: { edit: "deny" },
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

  it("rejects an unresolvable typed override before creating a child", async () => {
    const { coordinator, parent, journal } = await fixture();
    const result = await coordinator.runChild(
      {
        kind: "spawn",
        parentThread: parent,
        parentTurnId: "turn-1" as TurnId,
        agentSlug: "",
        prompt,
        overrides: { subagents: ["ghost"] },
        budget,
      },
      { mode: "foreground" },
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe("spawn_invocation_patch_invalid");
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
        tools: { edit: "allow", ask_user: "allow" },
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
    expect(binding?.configuration.tools).toEqual({ edit: "allow", ask_user: "allow" });
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
    const { coordinator, parent, repos, eventWriter } = await fixture();
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
    const firstTranscript = transcriptFor(parent.id as ThreadId, { repos, eventWriter }, "turn-2");
    const secondTranscript = transcriptFor(parent.id as ThreadId, { repos, eventWriter }, "turn-3");

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
      { mode: "foreground", transcript: firstTranscript },
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
      { mode: "foreground", transcript: secondTranscript },
    );
    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    if (first.status !== "completed" || second.status !== "completed") return;
    expect(first.report.threadId).toBe(childId);
    expect(second.report.threadId).toBe(childId);
    expect(first.report.summary).not.toBe(second.report.summary);
    const firstCardId = firstTranscript.journal.find((event) => event.type === "block.upserted")
      ?.block.id;
    const secondCardId = secondTranscript.journal.find((event) => event.type === "block.upserted")
      ?.block.id;
    expect(firstCardId).toBeTruthy();
    expect(secondCardId).toBeTruthy();
    expect(firstCardId).not.toBe(secondCardId);
    expect((await repos.blocks.findById(firstCardId ?? ""))?.content).toMatchObject({
      kind: "helper-result",
      props: {
        parentTurnId: "turn-2",
        toolCallId: "call-first",
        childThreadId: childId,
        deliveryMode: "direct",
        execution: first.execution,
      },
    });
    expect((await repos.blocks.findById(secondCardId ?? ""))?.content).toMatchObject({
      kind: "helper-result",
      props: {
        parentTurnId: "turn-3",
        toolCallId: "call-second",
        childThreadId: childId,
        deliveryMode: "direct",
        execution: second.execution,
      },
    });
  });

  it("reports busy on the attempted card without creating a child execution", async () => {
    const { coordinator, parent, repos, journal, runClaim, eventWriter } = await fixture();
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

    const transcript = transcriptFor(parent.id, { repos, eventWriter }, "turn-2");
    const heldLease = await runClaim.startExecution(childId, "blocking-run");
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
        { mode: "foreground", transcript },
      );
      expect(busy.status).toBe("error");
      if (busy.status === "error") {
        expect(busy.error.code).toBe("thread_message_target_busy");
        // The error reaches the model; it must not carry the child UUID.
        expect(busy.error.message).not.toContain(childId);
        expect(busy.error.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
      }
    } finally {
      if (heldLease) await runClaim.release(heldLease);
    }

    expect(transcript.allBlocks).toHaveLength(1);
    expect((await repos.blocks.findById(transcript.allBlocks[0].id))?.content).toMatchObject({
      props: { status: "failed", execution: null },
    });
    const after = await repos.threads.findById(childId);
    expect(after?.spawnStatus).toBe(before?.spawnStatus);
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

    const customBlocks = transcript.journal.flatMap((event) =>
      event.type === "block.upserted" && event.block.blockType === "custom" ? [event.block] : [],
    );
    expect(customBlocks.length).toBe(1);
    expect(customBlocks[0]?.content).toMatchObject({
      kind: "helper-result",
      props: {
        status: "running",
        childThreadId: spawned.report.threadId,
        parentTurnId: "turn-1",
        toolCallId: "test-invocation-1",
        deliveryMode: "direct",
        execution: null,
      },
    });
    const admittedCard = transcript.journal.find(
      (event) => event.type === "block.updated" && event.block.id === customBlocks[0]?.id,
    );
    expect(admittedCard).toMatchObject({
      type: "block.updated",
      block: {
        id: customBlocks[0]?.id,
        turnId: "turn-1",
        sequence: customBlocks[0]?.sequence,
        content: {
          kind: "helper-result",
          props: {
            status: "running",
            parentTurnId: "turn-1",
            toolCallId: "test-invocation-1",
            deliveryMode: "direct",
            execution: spawned.execution,
          },
        },
      },
    });
    expect((await repos.blocks.findById(customBlocks[0]?.id ?? ""))?.content).toMatchObject({
      kind: "helper-result",
      props: {
        status: "completed",
        childThreadId: spawned.report.threadId,
        parentTurnId: "turn-1",
        toolCallId: "test-invocation-1",
        deliveryMode: "direct",
        execution: spawned.execution,
      },
    });
  });

  it("keeps the same background run card and replaces only its status at publication", async () => {
    const { coordinator, parent, repos, eventWriter, journal } = await fixture();
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
      { mode: "background", transcript },
    );
    expect(spawned.status).toBe("background");
    if (spawned.status !== "background") return;

    const customBlocks = transcript.journal.flatMap((event) =>
      event.type === "block.upserted" && event.block.blockType === "custom" ? [event.block] : [],
    );
    expect(customBlocks).toHaveLength(1);
    expect(customBlocks[0]?.content).toMatchObject({
      kind: "helper-result",
      props: {
        status: "running",
        childThreadId: spawned.threadId,
        parentTurnId: "turn-1",
        toolCallId: "test-invocation-1",
        deliveryMode: "background_notification",
        execution: null,
      },
    });
    const cardId = customBlocks[0]?.id;
    if (!cardId) throw new Error("missing running card id");

    await vi.waitFor(async () => {
      expect((await repos.blocks.findById(cardId))?.content).toMatchObject({
        kind: "helper-result",
        props: {
          status: "completed",
          parentTurnId: "turn-1",
          toolCallId: "test-invocation-1",
          deliveryMode: "background_notification",
          execution: spawned.execution,
        },
      });
    });
    expect((await repos.blocks.findById(cardId))?.pruned).not.toBe(true);
    expect(journal.some((entry) => entry.type === "block.updated")).toBe(true);
  });

  it("returns a background execution only after admission, without waiting for terminal", async () => {
    let allowAdmission!: () => void;
    let allowTerminal!: () => void;
    const admissionGate = new Promise<void>((resolve) => {
      allowAdmission = resolve;
    });
    const terminalGate = new Promise<void>((resolve) => {
      allowTerminal = resolve;
    });
    const { coordinator, parent, repos, eventWriter } = await fixture({
      orchestrator: (repositories) => {
        const base = stubOrchestrator([], repositories);
        return {
          ...base,
          async prepare(input) {
            await admissionGate;
            const admitted = await base.prepare(input);
            return {
              ...admitted,
              execute: async () => {
                await terminalGate;
                return admitted.execute();
              },
            };
          },
        };
      },
    });
    const transcript = transcriptFor(parent.id as ThreadId, { repos, eventWriter });
    let returned = false;
    const running = coordinator
      .runChild(
        {
          kind: "spawn",
          parentThread: parent,
          parentTurnId: "turn-1" as TurnId,
          prompt,
          budget,
        },
        { mode: "background", transcript },
      )
      .then((result) => {
        returned = true;
        return result;
      });
    await vi.waitFor(() =>
      expect(transcript.journal.some((event) => event.type === "block.upserted")).toBe(true),
    );
    expect(returned).toBe(false);
    allowAdmission();
    const result = await running;
    expect(result.status).toBe("background");
    if (result.status !== "background") throw new Error("expected background run");
    if (!result.threadId || !result.execution) throw new Error("background run has no execution");
    const childThreadId = result.threadId;
    const execution = result.execution;
    expect(
      (await repos.executionReports.findByExecution(childThreadId, execution))?.outcome,
    ).toBeNull();
    const cardId = transcript.journal.find((event) => event.type === "block.upserted")?.block.id;
    expect((await repos.blocks.findById(cardId ?? ""))?.content).toMatchObject({
      kind: "helper-result",
      props: {
        status: "running",
        parentTurnId: "turn-1",
        toolCallId: "test-invocation-1",
        deliveryMode: "background_notification",
        execution: result.execution,
      },
    });
    allowTerminal();
    await vi.waitFor(async () => {
      expect(
        (await repos.executionReports.findByExecution(childThreadId, execution))?.outcome,
      ).toBe("succeeded");
    });
  });

  it("marks the original background card failed if assistant-turn admission never commits", async () => {
    const { coordinator, parent, repos, eventWriter, journal } = await fixture({
      orchestrator: {
        async prepare() {
          throw new Error("setup rolled back");
        },
      },
    });
    const transcript = transcriptFor(parent.id as ThreadId, { repos, eventWriter });
    await expect(
      coordinator.runChild(
        {
          kind: "spawn",
          parentThread: parent,
          parentTurnId: "turn-1" as TurnId,
          agentSlug: "",
          prompt,
          budget,
        },
        { mode: "background", transcript },
      ),
    ).rejects.toThrow("setup rolled back");
    const card = transcript.journal.find(
      (event) => event.type === "block.upserted" && event.block.blockType === "custom",
    );
    if (card?.type !== "block.upserted") throw new Error("missing original card");
    expect((await repos.blocks.findById(card.block.id))?.content).toMatchObject({
      kind: "helper-result",
      props: {
        status: "failed",
        parentTurnId: "turn-1",
        toolCallId: "test-invocation-1",
        deliveryMode: "background_notification",
        execution: null,
      },
    });
    const childId = journal.find((entry) => entry.type === "agent.spawn")?.childThreadId;
    if (!childId) throw new Error("missing created child");
    expect((await repos.threads.findById(childId as ThreadId))?.spawnStatus).toBe("failed");
  });

  it("enqueues one agent message for a background message and wakes the target", async () => {
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

    const pending = await inbox.selectPending(childId);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      threadId: childId,
      intent: "message",
      provenance: { kind: "agent", threadId: parent.id },
      body: { kind: "text", text: "run in the background" },
      idempotencyKey: "thread-message:call-bg",
    });
    // A message wakes the (asleep) target; the caller drives nothing here.
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
    // Foreground drives in-process; it never enqueues a message on the target.
    expect(runStarter.started).not.toContain(spawned.report.threadId);
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

describe("ChildRunCoordinator direct-parent activity journal", () => {
  it("appends a child spawned from a fork to the fork's journal, not its source's", async () => {
    const { coordinator, parent, repos, revisions, parentConfiguration, journal } = await fixture();
    const cutoff = await repos.turns.create({
      threadId: parent.id as ThreadId,
      role: "user",
      origin: "writer",
      status: "complete",
    });
    const binding = await revisions.readThreadBinding(parent.id);
    if (!binding?.revision) throw new Error("parent binding missing");
    const fork = await repos.threads.createDerivedPrimary({
      userId: parent.userId,
      projectId: parent.projectId,
      workId: parent.workId,
      source: parent,
      originType: "fork",
      originTurnId: cutoff.id,
    });
    const callerTurn = await repos.turns.create({
      threadId: fork.id as ThreadId,
      prevTurnId: cutoff.id,
      role: "assistant",
      origin: "assistant",
      status: "complete",
    });
    await revisions.bindThread(fork.id, binding.revision.id, parentConfiguration, null);
    journal.length = 0;

    const result = await coordinator.runChild(
      {
        kind: "spawn",
        parentThread: fork,
        parentTurnId: callerTurn.id as TurnId,
        agentSlug: "",
        prompt,
        budget,
      },
      { mode: "foreground" },
    );

    expect(result.status).toBe("completed");
    const activityEvents = journal.filter((entry) => entry.type === "subagent.activity");
    expect(activityEvents).toHaveLength(2);
    expect(activityEvents.every((entry) => entry.threadId === fork.id)).toBe(true);
    expect(activityEvents.every((entry) => entry.threadId !== parent.id)).toBe(true);
  });

  it("appends nested subagent.activity to its direct parent's journal on create and terminal", async () => {
    const { coordinator, parent, repos, journal } = await fixture();
    const outer = await coordinator.runChild(
      {
        kind: "spawn",
        parentThread: parent,
        parentTurnId: "outer-turn" as TurnId,
        agentSlug: "",
        prompt,
        budget,
      },
      { mode: "foreground" },
    );
    if (outer.status !== "completed") throw new Error("outer spawn failed");
    const nestedParent = await repos.threads.findById(outer.report.threadId as ThreadId);
    if (!nestedParent) throw new Error("outer child missing");
    const parentThreadId = nestedParent.id as ThreadId;
    journal.length = 0;

    const result = await coordinator.runChild(
      {
        kind: "spawn",
        parentThread: nestedParent,
        parentTurnId: "nested-turn" as TurnId,
        agentSlug: "",
        prompt,
        budget,
      },
      { mode: "foreground" },
    );
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    const childThreadId = result.report.threadId;

    const activityEvents = journal.filter((entry) => entry.type === "subagent.activity");
    // One on create (after the lease is acquired) and one on terminal.
    expect(activityEvents).toHaveLength(2);
    expect(activityEvents.every((entry) => entry.threadId === parentThreadId)).toBe(true);
    expect(activityEvents.every((entry) => entry.threadId !== parent.id)).toBe(true);
    expect(activityEvents.every((entry) => entry.childThreadId === childThreadId)).toBe(true);
    // The other lifecycle facts still land on the immediate parent.
    expect(journal.some((entry) => entry.type === "agent.spawn")).toBe(true);
  });

  it("emits the terminal activity frame asleep after the lease is released", async () => {
    const { coordinator, parent, journal } = await fixture();
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
    const childThreadId = result.report.threadId;

    const activityEvents = journal.filter((entry) => entry.type === "subagent.activity");
    expect(activityEvents).toHaveLength(2);
    const terminal = activityEvents[1] as unknown as {
      activity: {
        children: Array<{ threadId: string; status: { kind: string }; spawnStatus: string }>;
      };
    };
    const node = terminal.activity.children.find((entry) => entry.threadId === childThreadId);
    expect(node?.spawnStatus).toBe("succeeded");
    expect(node?.status.kind).toBe("asleep");
  });

  it("keeps a successful foreground run successful when the terminal activity append throws", async () => {
    const appended: Array<{ type: string; outcome?: string }> = [];
    let activityAppends = 0;
    const eventWriter: EventJournalWriter = {
      async appendEvent(_threadId, event) {
        const typed = event as unknown as { type: string; outcome?: string };
        if (typed.type === "subagent.activity") {
          activityAppends += 1;
          if (activityAppends === 2) throw new Error("terminal activity append exploded");
        }
        appended.push(typed);
        return BigInt(appended.length);
      },
    };
    const { coordinator, parent, eventSink } = await fixture({ eventWriter });

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
    // The create-side append landed; only the best-effort terminal append failed.
    expect(appended.filter((entry) => entry.type === "subagent.activity")).toHaveLength(1);
    // Exactly one terminal fact, and it records the run's success.
    const terminal = appended.filter((entry) => entry.type === "agent.run_completed");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.outcome).toBe("succeeded");
    expect(terminal[0]).not.toHaveProperty("result");
    // The swallowed failure is still observable.
    expect(eventSink.events.some((event) => event.name === "subagent.activity.append_failed")).toBe(
      true,
    );
  });

  it("writes no contradictory terminal event when a background run's terminal append throws", async () => {
    const appended: Array<{ type: string; outcome?: string }> = [];
    let activityAppends = 0;
    const eventWriter: EventJournalWriter = {
      async appendEvent(_threadId, event) {
        const typed = event as unknown as { type: string; outcome?: string };
        if (typed.type === "subagent.activity") {
          activityAppends += 1;
          if (activityAppends === 2) throw new Error("terminal activity append exploded");
        }
        appended.push(typed);
        return BigInt(appended.length);
      },
    };
    const { coordinator, parent } = await fixture({ eventWriter });

    const result = await coordinator.runChild(
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
    expect(result.status).toBe("background");

    await vi.waitFor(() => {
      expect(appended.filter((entry) => entry.type === "agent.run_completed")).toHaveLength(1);
    });
    const terminal = appended.filter((entry) => entry.type === "agent.run_completed");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.outcome).toBe("succeeded");
    expect(terminal[0]).not.toHaveProperty("result");
  });

  it("appends subagent.activity when a foreground message wakes a thread", async () => {
    const { coordinator, parent, journal } = await fixture();
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
    // Create + terminal for the spawn.
    expect(journal.filter((entry) => entry.type === "subagent.activity")).toHaveLength(2);

    const messaged = await coordinator.runChild(
      {
        kind: "message",
        parentThread: parent,
        parentTurnId: "turn-2" as TurnId,
        ref: spawned.report.handle,
        prompt: "keep going",
        toolCallId: "call-1",
        budget,
      },
      { mode: "foreground" },
    );
    expect(messaged.status).toBe("completed");
    // Admission activity belongs to RunSession; this fixture stubs preparation.
    expect(journal.filter((entry) => entry.type === "subagent.activity")).toHaveLength(3);
  });
});
