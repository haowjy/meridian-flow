/** One runtime composition: resolve ports first, then derive delivery, producer and loop. */

import type { ProjectPreferences } from "@meridian/contracts/preferences";
import { type AGUIEvent, EventType, type UserMessageBlock } from "@meridian/contracts/protocol";
import { testWorkSlug } from "../../../../test-support/work-slug.js";
import {
  type CreditLedger,
  createBillingUsagePolicy,
  createInMemoryCreditLedger,
} from "../../../billing/index.js";
import { createContextCatalogWakeHub } from "../../../context/context-catalog-wake-hub.js";
import type { NoticePort } from "../../../notices/index.js";
import { createInMemoryEventSink } from "../../../observability/index.js";
import { createInMemoryAccountSkillInstallStore } from "../../../packages/index.js";
import { createInMemoryProjectPreferencesRepository } from "../../../preferences/index.js";
import { createInMemoryProjectRepository } from "../../../projects/index.js";
import { readThreadActivity } from "../../../threads/domain/thread-activity.js";
import {
  createActiveDocumentResolver,
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
  createThreadEventHub,
  type SequencedEventInternal,
  type ThreadRepositories,
} from "../../../threads/index.js";
import {
  createInMemoryInbox,
  createInMemoryRunClaim,
  createInMemoryRuntimeDelivery,
  createInMemoryThreadLock,
} from "../../adapters/in-memory/loop-ports.js";
import { createWriterTurnProducer } from "../../admission/writer-turn-producer.js";
import type { Gateway, StreamEvent } from "../../gateway/index.js";
import { createInMemoryModelRequestDebugStore } from "../../model-request-debug/index.js";
import type { ChildRunCoordinator } from "../../spawn/child-run-coordinator.js";
import { createToolExecutor, createToolRegistry } from "../../tools/index.js";
import { createNoopInterruptArtifactFlushPort } from "../interrupt-session.js";
import { createInterruptRegistry } from "../interrupts.js";
import type { OrchestratorDeps } from "../orchestrator.js";
import { createOrchestrator } from "../orchestrator.js";
import { readPendingInbox } from "../pending-inbox.js";
import type { PreparedRun } from "../run-turn-port.js";
import { createTestAgentBinding, createTestNoticePort } from "./runtime-fixtures.js";
import { createInertGateway } from "./test-gateway.js";

function noopChildRunCoordinator(): ChildRunCoordinator {
  return {
    async runChild() {
      throw new Error("Test child run coordinator not configured");
    },
  };
}

export function createRuntimeHarness(
  overrides: Partial<OrchestratorDeps> & {
    repos?: ThreadRepositories;
    inbox?: import("../../adapters/runtime-delivery.js").DeliveryStore;
    threadLock?: import("../thread-lock.js").ThreadLock;
    creditLedger?: CreditLedger;
    boundThreads?: () => readonly string[];
    /** Delivery-only: `OrchestratorDeps` has no `notices` field of its own. */
    notices?: NoticePort;
    runStarter?: Parameters<typeof createInMemoryRuntimeDelivery>[0]["runStarter"];
    schedulePostCommit?: Parameters<typeof createInMemoryRuntimeDelivery>[0]["schedulePostCommit"];
  } = {},
) {
  const {
    boundThreads,
    inbox: suppliedInbox,
    threadLock: suppliedLock,
    runStarter,
    schedulePostCommit,
    creditLedger: suppliedLedger,
    notices: suppliedNotices,
    ...dependencies
  } = overrides;
  const projects = createInMemoryProjectRepository();
  const repos = overrides.repos ?? createInMemoryRepositories({ projects });
  const activeDocuments = createActiveDocumentResolver(repos);
  const preferences = createInMemoryProjectPreferencesRepository();
  const projectPreferences = {
    async read(userId: string, projectId: string): Promise<ProjectPreferences> {
      return preferences.read(userId, projectId);
    },
  };

  const creditLedger = suppliedLedger ?? createInMemoryCreditLedger();
  const gateway = overrides.gateway ?? createInertGateway();

  const journal = createInMemoryEventJournalWriter();
  const eventWriter = overrides.eventWriter ?? journal;
  const toolRegistry = overrides.toolRegistry ?? createToolRegistry();
  const notices = suppliedNotices ?? createTestNoticePort();
  const runClaim = overrides.runClaim ?? createInMemoryRunClaim();
  const inbox = suppliedInbox ?? createInMemoryInbox();
  const threadLock = suppliedLock ?? createInMemoryThreadLock();
  const workContext = overrides.workContext ?? {
    async renderForThread() {
      return {
        text: "<work_context>\ntest\n</work_context>",
        current: {
          projectId: "00000000-0000-0000-0000-000000000001",
          execution: {
            scope: {
              workId: "00000000-0000-0000-0000-000000000002",
              workSlug: testWorkSlug("test-work"),
            },
            aiWriteMode: "direct" as const,
            draftOwner: null,
          },
        },
      };
    },
  };
  // The non-durable inbox fake has no transaction callbacks. Ordinary sends
  // flush their wake only after the producer's repository transaction returns.
  const wakes: Array<() => Promise<void>> = [];
  const flushWakes = async () => {
    for (const wake of wakes.splice(0)) await wake();
  };
  const deps: OrchestratorDeps & { creditLedger: CreditLedger } = {
    creditLedger,
    gateway,
    toolExecutor: overrides.toolExecutor ?? createToolExecutor(toolRegistry),
    referenceReader: {
      async read() {
        throw new Error("Reference reader not configured");
      },
    },
    repos,
    eventWriter,
    headSeq: overrides.eventWriter
      ? async (id) => BigInt((await repos.threads.findById(id))?.nextSeq ?? 0)
      : (id) => journal.headSeq(id),
    agentRevisions: createTestAgentBinding(
      gateway.getDefaultModel?.() ?? "stub-model",
      "",
      boundThreads,
    ),
    accountSkillInstalls: createInMemoryAccountSkillInstallStore(),
    toolRegistry,
    projectPreferences,
    workWriteMode: {
      async read() {
        return "direct";
      },
    },
    billingUsage: overrides.billingUsage ?? createBillingUsagePolicy(creditLedger),
    interruptArtifacts: createNoopInterruptArtifactFlushPort(),
    childRunCoordinator: noopChildRunCoordinator(),
    interruptRegistry: createInterruptRegistry(),
    eventSink: createInMemoryEventSink(),
    modelRequestDebug: createInMemoryModelRequestDebugStore(),
    runClaim,
    delivery:
      overrides.delivery ??
      createInMemoryRuntimeDelivery({
        workContext,
        repos,
        eventWriter,
        notices,
        runClaim: runClaim as ReturnType<typeof createInMemoryRunClaim>,
        inbox,
        threadLock,
        runStarter: runStarter ?? { async start() {} },
        schedulePostCommit:
          schedulePostCommit ??
          ((task) => {
            wakes.push(task);
          }),
      }),
    activeDocuments,
    imageAssets: overrides.imageAssets ?? {
      async resolve() {
        return null;
      },
    },
    responseWrites: {
      async commitResponse() {
        return { status: "committed", receipts: [], concurrentEdits: [] };
      },
      async rollbackResponse() {},
    },
    ...dependencies,
    workContext,
  };
  let runtime: ReturnType<typeof createOrchestrator>;
  const orchestrator = () => (runtime ??= createOrchestrator(deps));
  const producer = createWriterTurnProducer({
    persistence: { repos, eventWriter },
    hub: { headSeq: deps.headSeq },
    runner: { getRunningTurn: (id) => orchestrator().getRunningTurn(id) },
    turns: repos.turns,
    delivery: deps.delivery,
    inbox: deps.delivery,
    records: {
      async lookup() {
        return null;
      },
      async reserve() {
        return { kind: "reserved" };
      },
      async recoverExpiredPending() {
        return null;
      },
      async reject() {
        throw new Error("Unexpected rejection");
      },
      async retire(input) {
        return { kind: "retired", submissionId: input.submissionId, code: "retired" };
      },
      async accept(input) {
        return { kind: "accepted", response: input.response };
      },
    },
    async consumeUploads() {},
    async attachDocument() {},
  });
  return {
    deps,
    flushWakes,
    repos,
    creditLedger,
    eventWriter,
    inbox: deps.delivery,
    runClaim,
    get orchestrator() {
      return orchestrator();
    },
    delivery: deps.delivery,
    async send(
      threadId: string,
      text: string,
      options: { blocks?: UserMessageBlock[]; activatedSkillSlugs?: readonly string[] } = {},
    ) {
      const thread = await repos.threads.findById(threadId);
      if (!thread) throw new Error("Missing fixture thread");
      const blocks = options.blocks ?? [{ type: "text", text }];
      const result = await producer.enqueue({
        admission: {
          actorUserId: thread.userId,
          threadId,
          submissionId: crypto.randomUUID(),
          text,
          blocks,
          references: [],
          activatedSkillSlugs: options.activatedSkillSlugs,
        },
        fingerprint: "fixture-fingerprint",
        blocks,
        references: [],
      });
      await flushWakes();
      if (!("userTurnId" in result)) throw new Error("Expected accepted fixture send");
      return result;
    },
    startDrain: (threadId: string) => orchestrator().startDrain(threadId),
  };
}

/** Seed ownership and credits around the same composition, with optional real gateway. */
export async function runtimeScenario(
  options: Omit<Partial<OrchestratorDeps>, "repos" | "eventWriter" | "headSeq"> & {
    gateway: Gateway;
    userId?: string;
    projectTitle?: string;
    creditsMillicredits?: string;
    signalGatewayEvent?: (event: StreamEvent) => boolean;
    runStarter?: NonNullable<Parameters<typeof createRuntimeHarness>[0]>["runStarter"];
    notices?: NonNullable<Parameters<typeof createRuntimeHarness>[0]>["notices"];
  },
) {
  const {
    userId = "user-1",
    projectTitle = "Runtime",
    creditsMillicredits = "1000000",
    signalGatewayEvent,
    ...ports
  } = options;
  const projects = createInMemoryProjectRepository();
  const repos = createInMemoryRepositories({ projects });
  const project = await projects.create({ userId, title: projectTitle });
  const thread = await repos.threads.create({ userId, projectId: project.id });
  const journal = createInMemoryEventJournalWriter();
  const eventSink = options.eventSink ?? createInMemoryEventSink();
  const hub = createThreadEventHub({ journalWriter: journal, journalReader: journal, eventSink });
  const gatewaySignal = runtimeGate();
  const gateway: Gateway = {
    ...options.gateway,
    async *stream(request) {
      for await (const event of options.gateway.stream(request)) {
        if ((signalGatewayEvent ?? ((e: StreamEvent) => e.type.endsWith(".delta")))(event))
          gatewaySignal.open();
        yield event;
      }
    },
  };
  let settledRuns = 0;
  const settled = new Map<number, ReturnType<typeof runtimeGate<void>>>();
  function untilSettled(count = 1) {
    if (settledRuns >= count) return Promise.resolve();
    let gate = settled.get(count);
    if (!gate) {
      gate = runtimeGate();
      settled.set(count, gate);
    }
    return gate.promise;
  }
  const harness = createRuntimeHarness({
    ...ports,
    gateway,
    repos,
    eventWriter: hub,
    headSeq: (id) => hub.headSeq(id),
    boundThreads: () => [thread.id],
    onRunSettled(id) {
      options.onRunSettled?.(id);
      settled.get(++settledRuns)?.open();
    },
  });
  await harness.creditLedger.grant({
    userId,
    source: "manual",
    amountMillicredits: creditsMillicredits,
    reason: "runtime fixture",
  });
  const projectedEvents: SequencedEventInternal[] = [];
  const waiters = new Set<{ type: AGUIEvent["type"]; resolve: (event: AGUIEvent) => void }>();
  hub.subscribe(thread.id, (entry) => {
    projectedEvents.push(entry);
    for (const waiter of waiters)
      if (waiter.type === entry.event.type) {
        waiters.delete(waiter);
        waiter.resolve(entry.event);
      }
  });
  function awaitEvent(type: AGUIEvent["type"]): Promise<AGUIEvent> {
    const existing = projectedEvents.find((entry) => entry.event.type === type);
    if (existing) return Promise.resolve(existing.event);
    return new Promise((resolve) => waiters.add({ type, resolve }));
  }
  return {
    ...harness,
    repos,
    userId,
    project,
    thread,
    gateway,
    gatewaySignal,
    journal,
    hub,
    projectedEvents,
    runner: harness.orchestrator,
    awaitEvent,
    untilSettled,
    balance: () => harness.creditLedger.getBalance({ userId }),
    turn: (turnId: string) => repos.turns.findById(turnId),
    async execute(run: PreparedRun) {
      const outcome = await run.execute();
      return { outcome, events: journal.getEvents(thread.id).map((entry) => entry.event) };
    },
    async awaitCancelled(turnId: string) {
      await awaitEvent(EventType.RUN_FINISHED);
      return repos.transaction(() => repos.turns.findById(turnId));
    },
    createAppServices() {
      return {
        runner: harness.orchestrator,
        eventSink,
        threadEventHub: hub,
        projectRepo: projects,
        interruptRegistry: harness.deps.interruptRegistry,
        contextCatalogWakeHub: createContextCatalogWakeHub(),
        threadRuntime: {
          async requireOwnedThread(id: string, owner: string) {
            const row = await repos.threads.findById(id);
            if (!row || row.userId !== owner) throw new Error("Thread not found");
            return {
              ...row,
              activeLeafTurnId: row.activeLeafTurnId ?? null,
              workId: null,
              nextSeq: await hub.headSeq(id),
            };
          },
          async liveState(id: string, _owner?: string) {
            return {
              threadId: id,
              status: await harness.runClaim.read(id),
              runningTurnId: await harness.runClaim.readRunningTurnId(id),
              activity: await readThreadActivity(
                { threads: repos.threads, statusReader: harness.runClaim },
                id,
              ),
              pending: await readPendingInbox(harness.delivery, id),
              resumeAfterSeq: (await hub.headSeq(id)).toString(),
            };
          },
        },
      };
    },
  };
}
export type RuntimeHarness = Awaited<ReturnType<typeof runtimeScenario>>;
export function runtimeGate<T = void>() {
  let open!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, fail) => {
    open = resolve;
    reject = fail;
  });
  return { promise, open, reject };
}
