/**
 * Spawn selection contracts: named roster targets (including primary mode),
 * the generic omitted/empty-agent subagent inheriting caller config, and the
 * pre-create depth refusal. Runs exercise the unified `runChild` entrypoint.
 */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { createDefaultTreeBudget, type SpawnResult } from "@meridian/contracts/spawn";
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
import type { scriptedGateway } from "../loop/__tests__/test-gateway.js";
import type { RunTurnPort } from "../loop/run-turn-port.js";
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
        executionTurnId: assistantTurnId,
        handle: child.ref,
        ...(input.executionReport?.correlation ?? {
          origin: "thread_run" as const,
          deliveryMode: "none" as const,
          callerThreadId: null,
          callerTurnId: null,
          toolCallId: null,
          cardBlockId: null,
        }),
        agentSlug: input.executionReport?.agentSlug ?? null,
        name: input.executionReport?.name ?? null,
      });
      return {
        userTurnId: userTurn.id,
        executionTurnId: assistantTurnId,
        runId: assistantTurnId,
        resumeAfterSeq: "0",
        snapshotFloorNextSeq: "1",
        execute: async () => {
          await repos.executionReports.captureOnce(input.threadId, assistantTurnId, "return", {
            summary: `child report ${counter}`,
          });
          await repos.executionReports.finalizeOnce({
            childThreadId: input.threadId,
            executionTurnId: assistantTurnId,
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
    realRuntime?: boolean;
    gateway?: ReturnType<typeof scriptedGateway>;
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
          permission: "read",
        },
        "You are Critic.",
      ),
      "agents/hidden.md": serializeMarkdownDefinition(
        { name: "Hidden", model: "hidden-model", "model-invocable": false },
        "",
      ),
      "skills/continuity/SKILL.md":
        "---\nname: continuity\ndescription: Check facts against canon.\n---\n\ncontinuity body.\n",
      "skills/story-review/SKILL.md":
        "---\nname: story-review\ndescription: Review drafts after prose exists.\n---\n\nstory-review body.\n",
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
          "disallowed-tools": ["ask_user"],
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
    permission: "edit" as const,
    "disallowed-tools": ["ask_user"],
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
    readThreadActivity(
      { threads: repos.threads, statusReader: runClaim, executionReports: repos.executionReports },
      threadId,
    );
  const inbox = createInMemoryInbox();
  const runStarter = createInMemoryRunStarter();
  const runtimeHarness = createRuntimeHarness({
    repos,
    eventWriter,
    agentRevisions: revisions,
    ...(options.gateway ? { gateway: options.gateway } : {}),
    runClaim,
    inbox,
    threadLock: createInMemoryThreadLock(),
    runStarter,
    schedulePostCommit: (task) => task(),
  });
  const delivery = runtimeHarness.delivery;
  const publisher = createReportPublisher({ repos, eventWriter, delivery, eventSink });

  const driver = createChildRunDriver({
    backgroundTasks: runtimeHarness.backgroundTasks,
    orchestrator:
      typeof options.orchestrator === "function"
        ? options.orchestrator(repos)
        : (options.orchestrator ??
          (options.realRuntime
            ? runtimeHarness.orchestrator
            : stubOrchestrator(turns, repos, runClaim))),
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
      turns: repos.turns,
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
  // Override refusals come back typed; `runChild` is for tests that expect a run.
  const runChildOrRefusal = async (
    request: Parameters<typeof coreCoordinator.runChild>[0],
    options: Parameters<typeof coreCoordinator.runChild>[1],
  ) => {
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
          origin: request.kind === "spawn" ? "spawn" : "message",
          deliveryMode: options.mode === "background" ? "background_notification" : "direct",
        },
      },
      options,
    );
  };
  const coordinator = {
    ...coreCoordinator,
    runChildOrRefusal,
    async runChild(...args: Parameters<typeof runChildOrRefusal>): Promise<SpawnResult> {
      const result = await runChildOrRefusal(...args);
      if ("issues" in result) throw new Error(`Refused: ${JSON.stringify(result.issues)}`);
      return result;
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
    runtimeHarness,
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
});

describe("ChildRunCoordinator invocation overlay", () => {
  it("refuses a named child with a tool its parent lacks until the spawn denies it", async () => {
    const { coordinator, revisions, repos, critic, journal } = await fixture();
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
        namedTargets: [{ name: "critic", definitionRevisionId: critic.id }],
        permission: "edit" as const,
        "disallowed-tools": ["write"],
      },
      null,
    );
    const spawn = (overrides?: { "disallowed-tools": string[] }) =>
      coordinator.runChildOrRefusal(
        {
          kind: "spawn",
          parentThread: restrictedParent,
          parentTurnId: "turn-1" as TurnId,
          agentSlug: "critic",
          prompt,
          ...(overrides ? { overrides } : {}),
          budget,
        },
        { mode: "foreground" },
      );
    const refused = await spawn();
    expect(refused).toEqual({
      error: "invalid_arguments",
      issues: [
        {
          path: "overrides.disallowed_tools",
          message: 'critic has "write" and you don\'t; add it here',
        },
      ],
    });
    expect(journal.some((event) => event.type === "agent.spawn")).toBe(false);

    const narrowed = await spawn({ "disallowed-tools": ["write"] });
    if (!("status" in narrowed) || narrowed.status !== "completed")
      throw new Error("Expected a run");
    const binding = await revisions.readThreadBinding(narrowed.report.threadId);
    expect(binding?.configuration["disallowed-tools"]).toEqual(["write"]);
  });

  it("lets overrides.permission lower to read and refuses a raise as invalid arguments", async () => {
    const { coordinator, revisions, repos, parent, journal } = await fixture();
    const spawn = (parentThread: typeof parent, agentSlug: string, permission: "read" | "edit") =>
      coordinator.runChildOrRefusal(
        {
          kind: "spawn",
          parentThread,
          parentTurnId: "turn-1" as TurnId,
          agentSlug,
          prompt,
          overrides: { permission },
          budget,
        },
        { mode: "foreground" },
      );

    const lowered = await spawn(parent, "", "read");
    if (!("status" in lowered) || lowered.status !== "completed") throw new Error("Expected a run");
    const loweredBinding = await revisions.readThreadBinding(lowered.report.threadId);
    expect(loweredBinding?.configuration.permission).toBe("read");

    const spawnsBefore = journal.filter((event) => event.type === "agent.spawn").length;
    const readParent = await repos.threads.create({ userId: "user-1", projectId: "project-1" });
    const parentBinding = await revisions.readThreadBinding(parent.id);
    if (!parentBinding) throw new Error("Missing parent binding");
    await revisions.bindThread(
      readParent.id,
      null,
      { ...parentBinding.configuration, permission: "read" },
      null,
    );
    const underReadParent = await spawn(readParent, "", "edit");
    const overReadProfile = await spawn(parent, "critic", "edit");
    expect([underReadParent, overReadProfile]).toEqual([
      {
        error: "invalid_arguments",
        issues: [
          {
            path: "overrides.permission",
            message: 'can only lower permission, and yours is "read"',
          },
        ],
      },
      {
        error: "invalid_arguments",
        issues: [
          {
            path: "overrides.permission",
            message: 'can only lower permission, and critic\'s is "read"',
          },
        ],
      },
    ]);
    expect(journal.filter((event) => event.type === "agent.spawn")).toHaveLength(spawnsBefore);
  });
});

describe("ChildRunCoordinator thread_message", () => {
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
        terminalAt: null,
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
    const failureContent = (await repos.blocks.findById(card.block.id))?.content;
    expect(failureContent).toMatchObject({
      kind: "helper-result",
      props: {
        reason: "setup rolled back",
        terminalAt: expect.any(String),
        parentTurnId: "turn-1",
        toolCallId: "test-invocation-1",
        deliveryMode: "background_notification",
      },
    });
    expect(failureContent).not.toHaveProperty("props.childThreadId");
    expect(failureContent).not.toHaveProperty("props.execution");
    const childId = journal.find((entry) => entry.type === "agent.spawn")?.childThreadId;
    if (!childId) throw new Error("missing created child");
    expect((await repos.threads.findById(childId as ThreadId))?.spawnStatus).toBe("failed");
  });
});

describe("ChildRunCoordinator direct-parent activity journal", () => {
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
});
