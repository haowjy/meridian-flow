/** One runtime composition: resolve ports first, then derive delivery, producer and loop. */

import { type AGUIEvent, EventType, type UserMessageBlock } from "@meridian/contracts/protocol";
import {
  InMemoryTransactionOwner,
  noTransactionOwner,
} from "../../../../shared/in-memory-transaction.js";
import { testWorkHandle } from "../../../../test-support/work-handle.js";
import {
  type CreditLedger,
  createBillingUsagePolicy,
  createInMemoryCreditLedger,
} from "../../../billing/index.js";
import { createContextCatalogWakeHub } from "../../../context/context-catalog-wake-hub.js";
import type { NoticePort } from "../../../notices/index.js";
import { createInMemoryEventSink } from "../../../observability/index.js";
import { createInMemoryAccountSkillInstallStore } from "../../../packages/index.js";
import { createInMemoryProjectRepository } from "../../../projects/index.js";
import { readThreadActivity } from "../../../threads/domain/thread-activity.js";
import {
  createActiveDocumentResolver,
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
  createThreadEventHub,
  type InMemoryRepositories,
  type SequencedEventInternal,
  type ThreadRepositories,
} from "../../../threads/index.js";
import {
  createInMemoryInbox,
  createInMemoryRunClaim,
  createInMemoryRuntimeDelivery,
  createInMemoryThreadLock,
} from "../../adapters/in-memory/loop-ports.js";
import { createInMemoryObservationFrontiers } from "../../adapters/in-memory/observation-frontiers.js";
import { createInMemoryShownLinkStore } from "../../adapters/in-memory/shown-links.js";
import { createWriterTurnProducer } from "../../admission/writer-turn-producer.js";
import { createDetachedWorkTracker, type DetachedWorkTracker } from "../../detached-work.js";
import type { Gateway, StreamEvent } from "../../gateway/index.js";
import { createInMemoryModelRequestDebugStore } from "../../model-request-debug/index.js";
import type { ChildRunCoordinator } from "../../spawn/child-run-coordinator.js";
import { createToolExecutor, createToolRegistry } from "../../tools/index.js";
import type { OrchestratorDeps } from "../orchestrator.js";
import { createOrchestrator } from "../orchestrator.js";
import { createRunStarter } from "../run-starter.js";
import type { PreparedRun } from "../run-turn-port.js";
import { createWakeIfRunnable } from "../wake-if-runnable.js";
import { writeModeSwitchNotice } from "../write-mode-switch.js";
import { createTestAgentBinding, createTestNoticePort } from "./runtime-fixtures.js";
import { scriptedSummarizer } from "./scripted-summarizer.js";
import { createInertGateway } from "./test-gateway.js";

function noopChildRunCoordinator(): ChildRunCoordinator {
  return {
    async runChild() {
      throw new Error("Test child run coordinator not configured");
    },
    async readSavedReport() {
      return null;
    },
  };
}

export function createRuntimeHarness(
  overrides: Omit<Partial<OrchestratorDeps>, "backgroundTasks"> & {
    backgroundTasks?: DetachedWorkTracker;
    /** In-memory repositories carry their transaction owner; the harness's journal and shown-link store join it. */
    repos?: ThreadRepositories | InMemoryRepositories;
    inbox?: import("../../adapters/delivery-ports.js").DeliveryStore;
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
    backgroundTasks: suppliedBackgroundTasks,
    creditLedger: suppliedLedger,
    notices: suppliedNotices,
    ...dependencies
  } = overrides;
  const backgroundTasks = suppliedBackgroundTasks ?? createDetachedWorkTracker();
  const projects = createInMemoryProjectRepository();
  // Shown-link evidence commits through the repositories' transactions.
  const repos = overrides.repos ?? createInMemoryRepositories({ projects });
  // Repositories that are not in-memory (Drizzle) commit through the database transaction, not an owner.
  const transactionOwner =
    "transactionOwner" in repos ? repos.transactionOwner : noTransactionOwner;
  const activeDocuments = createActiveDocumentResolver(repos);

  const creditLedger = suppliedLedger ?? createInMemoryCreditLedger();
  const gateway = overrides.gateway ?? createInertGateway();

  const journal = createInMemoryEventJournalWriter(transactionOwner);
  const eventWriter = overrides.eventWriter ?? journal;
  const toolRegistry = overrides.toolRegistry ?? createToolRegistry();
  const notices = suppliedNotices ?? createTestNoticePort();
  const inbox = suppliedInbox ?? createInMemoryInbox();
  const runClaim = overrides.runClaim ?? createInMemoryRunClaim();
  const threadLock = suppliedLock ?? createInMemoryThreadLock();
  const shutdown = overrides.shutdown ?? { started: false };
  const workContext = overrides.workContext ?? {
    async renderForThread() {
      return {
        text: "<work_context>\ntest\n</work_context>",
        current: {
          projectId: "00000000-0000-0000-0000-000000000001",
          execution: {
            scope: {
              workId: "00000000-0000-0000-0000-000000000002",
              workHandle: testWorkHandle("w1"),
            },
            aiWriteMode: "direct" as const,
            branchOwner: null,
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
  let wakeIfRunnable!: (threadId: string) => Promise<void>;
  const deps: OrchestratorDeps & { creditLedger: CreditLedger } = {
    creditLedger,
    summarizer: scriptedSummarizer(),
    gateway,
    toolExecutor: overrides.toolExecutor ?? createToolExecutor(toolRegistry),
    documentRevisions: {
      async current({ documentIds }) {
        return new Map(documentIds.map((id) => [id, null]));
      },
    },
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
    billingUsage: overrides.billingUsage ?? createBillingUsagePolicy(creditLedger),
    childRunCoordinator: noopChildRunCoordinator(),
    eventSink: createInMemoryEventSink(),
    wakeIfRunnable: (threadId) => wakeIfRunnable(threadId),
    modelRequestDebug: createInMemoryModelRequestDebugStore(),
    runClaim,
    handoffBriefs: {
      async stop() {
        return false;
      },
    },
    delivery:
      overrides.delivery ??
      createInMemoryRuntimeDelivery({
        backgroundTasks,
        toolRegistry,
        workContext,
        repos,
        eventWriter,
        headSeq: (id) => journal.headSeq(id),
        notices,
        runClaim: runClaim as ReturnType<typeof createInMemoryRunClaim>,
        inbox,
        threadLock,
        runStarter: runStarter ?? { async start() {} },
        async publishFinalizedReports() {},
        writeModeSwitch: {
          async renderNotice(_threadId, mode) {
            return writeModeSwitchNotice({ archivedAt: null, isNoWork: false }, mode, false);
          },
          async setWorkDefault() {},
        },
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
        return { status: "committed", receipts: [], concurrentEdits: [], refused: [] };
      },
      async rollbackResponse() {},
    },
    shownLinks: createInMemoryShownLinkStore({
      transactionOwner:
        transactionOwner === noTransactionOwner ? new InMemoryTransactionOwner() : transactionOwner,
      threads: repos.threads,
      turns: repos.turns,
    }),
    observationFrontiers: createInMemoryObservationFrontiers({
      transactionOwner:
        transactionOwner === noTransactionOwner ? new InMemoryTransactionOwner() : transactionOwner,
    }),
    ...dependencies,
    backgroundTasks,
    shutdown,
    workContext,
  };
  let runtime: ReturnType<typeof createOrchestrator>;
  const orchestrator = () => (runtime ??= createOrchestrator(deps));
  wakeIfRunnable = createWakeIfRunnable({
    delivery: deps.delivery,
    runStarter: createRunStarter(
      { startDrain: (id) => orchestrator().startDrain(id) },
      deps.eventSink,
    ),
    shutdown,
  });
  const producer = createWriterTurnProducer({
    async requireWritableThread() {},
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
    backgroundTasks,
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
    /** Shared with a caller-built in-memory `shownLinks` store. */
    transactionOwner?: InMemoryTransactionOwner;
  },
) {
  const {
    userId = "user-1",
    projectTitle = "Runtime",
    creditsMillicredits = "1000000",
    signalGatewayEvent,
    transactionOwner = new InMemoryTransactionOwner(),
    ...ports
  } = options;
  const projects = createInMemoryProjectRepository();
  const repos = createInMemoryRepositories({ projects, transactionOwner });
  const project = await projects.create({ userId, title: projectTitle });
  const thread = await repos.threads.create({
    aiWriteMode: "direct",
    userId,
    projectId: project.id,
  });
  const journal = createInMemoryEventJournalWriter(transactionOwner);
  const eventSink = options.eventSink ?? createInMemoryEventSink();
  const hub = createThreadEventHub({
    journalWriter: journal,
    journalReader: journal,
    eventSink,
    inMemoryTransactionOwner: transactionOwner,
  });
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
  await hub.catchupAndSubscribe(thread.id, 0n, (entry) => {
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
              activity: await readThreadActivity(
                {
                  threads: repos.threads,
                  statusReader: harness.runClaim,
                  executionReports: repos.executionReports,
                },
                id,
              ),
              runState: await harness.delivery.answerRunState(id),
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
