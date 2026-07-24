/**
 * Composed runtime test environment with seeded ownership, credits, event
 * subscriptions, and observable turn outcomes.
 */

import { type AGUIEvent, EventType } from "@meridian/contracts/protocol";
import type { OrchestratorEvent } from "@meridian/contracts/threads";
import { createInMemoryAppServices } from "../../../../lib/compose.js";
import { createInMemoryCreditLedger } from "../../../billing/index.js";
import { createInMemoryEventSink } from "../../../observability/index.js";
import { createInMemoryProjectRepository } from "../../../projects/index.js";
import {
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
  createThreadEventHub,
  type SequencedEventInternal,
} from "../../../threads/index.js";
import type { Gateway, StreamEvent } from "../../gateway/index.js";
import { createToolExecutor, createToolRegistry } from "../../tools/index.js";
import { createInterruptRegistry } from "../interrupts.js";
import { createOrchestrator } from "../orchestrator.js";
import { createTurnRunner } from "../turn-runner.js";
import { createTestOrchestratorDeps } from "./test-orchestrator-deps.js";

export type RuntimeGate<T = void> = {
  promise: Promise<T>;
  open(value: T): void;
};

export function runtimeGate<T = void>(): RuntimeGate<T> {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

type RuntimeTestRigOptions = {
  gateway: Gateway;
  userId?: string;
  projectTitle?: string;
  creditsMillicredits?: string;
  signalGatewayEvent?: (event: StreamEvent) => boolean;
};

export class RuntimeTestRig {
  readonly userId: string;
  readonly gatewaySignal: RuntimeGate;
  readonly projectedEvents: SequencedEventInternal[] = [];
  readonly repos;
  readonly project;
  readonly thread;
  readonly creditLedger;
  readonly hub;
  readonly orchestrator;
  readonly runner;
  readonly gateway;

  private readonly eventWaiters = new Set<{
    predicate: (event: AGUIEvent) => boolean;
    resolve: (event: AGUIEvent) => void;
  }>();

  private constructor(state: {
    userId: string;
    gatewaySignal: RuntimeGate;
    gateway: Gateway;
    repos: ReturnType<typeof createInMemoryRepositories>;
    project: Awaited<ReturnType<ReturnType<typeof createInMemoryProjectRepository>["create"]>>;
    thread: Awaited<ReturnType<ReturnType<typeof createInMemoryRepositories>["threads"]["create"]>>;
    creditLedger: ReturnType<typeof createInMemoryCreditLedger>;
    hub: ReturnType<typeof createThreadEventHub>;
    orchestrator: ReturnType<typeof createOrchestrator>;
    runner: ReturnType<typeof createTurnRunner>;
  }) {
    Object.assign(this, state);
    this.userId = state.userId;
    this.gatewaySignal = state.gatewaySignal;
    this.gateway = state.gateway;
    this.repos = state.repos;
    this.project = state.project;
    this.thread = state.thread;
    this.creditLedger = state.creditLedger;
    this.hub = state.hub;
    this.orchestrator = state.orchestrator;
    this.runner = state.runner;
    this.hub.subscribe(this.thread.id, (entry) => {
      this.projectedEvents.push(entry);
      for (const waiter of this.eventWaiters) {
        if (!waiter.predicate(entry.event)) continue;
        this.eventWaiters.delete(waiter);
        waiter.resolve(entry.event);
      }
    });
  }

  static async create(options: RuntimeTestRigOptions): Promise<RuntimeTestRig> {
    const userId = options.userId ?? "user-1";
    const gatewaySignal = runtimeGate();
    const signalGatewayEvent =
      options.signalGatewayEvent ?? ((event: StreamEvent) => event.type.endsWith(".delta"));
    let signalled = false;
    const gateway: Gateway = {
      ...options.gateway,
      async *stream(request): AsyncGenerator<StreamEvent> {
        for await (const event of options.gateway.stream(request)) {
          if (!signalled && signalGatewayEvent(event)) {
            signalled = true;
            gatewaySignal.open();
          }
          yield event;
        }
      },
      generate: (request) => options.gateway.generate(request),
      getDefaultModel: () => options.gateway.getDefaultModel(),
    };
    const projectRepo = createInMemoryProjectRepository();
    const repos = createInMemoryRepositories({ projects: projectRepo });
    const project = await projectRepo.create({
      userId,
      title: options.projectTitle ?? "Runtime test project",
    });
    const creditLedger = createInMemoryCreditLedger();
    const eventWriter = createInMemoryEventJournalWriter();
    const eventSink = createInMemoryEventSink();
    const interruptRegistry = createInterruptRegistry();
    const hub = createThreadEventHub({
      journalWriter: eventWriter,
      journalReader: eventWriter,
      eventSink,
    });
    const orchestrator = createOrchestrator(
      createTestOrchestratorDeps({
        gateway,
        toolExecutor: createToolExecutor(createToolRegistry()),
        repos,
        eventWriter: hub,
        interruptRegistry,
        creditLedger,
        eventSink,
      }),
    );
    const runner = createTurnRunner({
      orchestrator,
      hub,
      repos: { turns: repos.turns },
      eventSink,
    });
    const thread = await repos.threads.create({ userId, projectId: project.id });
    await creditLedger.grant({
      userId,
      source: "manual",
      amountMillicredits: options.creditsMillicredits ?? "1000000",
      reason: "runtime test seed",
    });
    const rig = new RuntimeTestRig({
      userId,
      gatewaySignal,
      gateway,
      repos,
      project,
      thread,
      creditLedger,
      hub,
      orchestrator,
      runner,
    });
    return rig;
  }

  awaitEvent(type: AGUIEvent["type"]): Promise<AGUIEvent> {
    const existing = this.projectedEvents.find(({ event }) => event.type === type);
    if (existing) return Promise.resolve(existing.event);
    return new Promise((resolve) => {
      this.eventWaiters.add({ predicate: (event) => event.type === type, resolve });
    });
  }

  async collect(handle: {
    events: AsyncIterable<OrchestratorEvent>;
  }): Promise<OrchestratorEvent[]> {
    const events: OrchestratorEvent[] = [];
    for await (const event of handle.events) events.push(event);
    return events;
  }

  async balance(): Promise<string> {
    return this.creditLedger.getBalance({ userId: this.userId });
  }

  async turn(turnId: string) {
    return this.repos.turns.findById(turnId);
  }

  async awaitCancelled(turnId: string) {
    await this.awaitEvent(EventType.RUN_FINISHED);
    const turn = await this.turn(turnId);
    if (turn?.status !== "cancelled") {
      throw new Error(
        `Expected turn ${turnId} to be cancelled, received ${turn?.status ?? "missing"}`,
      );
    }
    return turn;
  }

  createAppServices() {
    const app = createInMemoryAppServices();
    app.gateway = this.gateway;
    app.threadRepos = this.repos;
    app.repos = this.repos;
    app.threadEventHub = this.hub;
    app.hub = this.hub;
    app.runner = this.runner;
    app.threadRuntime = {
      requireOwnedThread: async (threadId, userId) => {
        if (threadId !== this.thread.id || userId !== this.userId) throw new Error("not found");
        return {
          ...this.thread,
          workId: "work-1",
          currentAgentId: null,
          activeLeafTurnId: null,
          nextSeq: 0n,
          status: "active" as const,
        };
      },
      liveState: async () => ({
        threadId: this.thread.id,
        status: "idle" as const,
        runningTurnId: this.runner.getRunningTurnId(this.thread.id),
        currentAgent: null,
        resumeAfterSeq: "0",
      }),
      journalEvents: async () => [],
    };
    return app;
  }
}
