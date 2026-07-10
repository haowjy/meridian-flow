/**
 * Regression: verbatim system prompts captured for debug must not leak into
 * journal, snapshot, hub fan-out, or EventSink — only the debug store.
 */
import { createDefaultTreeBudget } from "@meridian/contracts/spawn";
import type { OrchestratorEvent } from "@meridian/contracts/threads";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInMemoryCreditLedger } from "../../../billing/index.js";
import { createInMemoryEventSink } from "../../../observability/index.js";
import { createInMemoryProjectRepository } from "../../../projects/index.js";
import {
  buildThreadSnapshot,
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
  createThreadEventHub,
  type SequencedEventInternal,
} from "../../../threads/index.js";
import {
  createGateway,
  createMockOpenAICompatibleServer,
  type MockOpenAIServer,
  mockProviderConfig,
} from "../../gateway/index.js";
import { createInMemoryModelRequestDebugStore } from "../../model-request-debug/index.js";
import { createOrchestrator } from "../orchestrator.js";
import { createTestOrchestratorDeps } from "./test-orchestrator-deps.js";

const LEAK_PROBE_MARKER = "MERIDIAN_DEBUG_LEAK_PROBE_MARKER_7f3a9c2e";

function serialized(value: unknown): string {
  return (
    JSON.stringify(value, (_key, entry) =>
      typeof entry === "bigint" ? entry.toString() : entry,
    ) ?? ""
  );
}

function expectMarkerAbsent(label: string, value: unknown): void {
  expect(serialized(value), `${label} must not contain debug system prompt`).not.toContain(
    LEAK_PROBE_MARKER,
  );
}

describe("model-request debug prompt leak guard", () => {
  let mock: MockOpenAIServer;

  beforeAll(async () => {
    mock = await createMockOpenAICompatibleServer();
  });

  afterAll(async () => {
    await mock.close();
  });

  it("keeps captured system prompts out of journal, snapshot, hub, and EventSink", async () => {
    const projectRepo = createInMemoryProjectRepository();
    const repos = createInMemoryRepositories({ projects: projectRepo });
    const project = await projectRepo.create({ userId: "user-1", title: "WB" });
    const thread = await repos.threads.create({
      projectId: project.id,
      id: "thread-leak-probe",
      userId: "user-1",
      title: null,
      systemPrompt: `You are helpful. ${LEAK_PROBE_MARKER}`,
      currentAgent: "agent-one",
    });
    const creditLedger = createInMemoryCreditLedger();
    await creditLedger.grant({
      userId: "user-1",
      source: "manual",
      amountMillicredits: "1000000000",
      reason: "test",
    });

    const eventWriter = createInMemoryEventJournalWriter();
    const eventSink = createInMemoryEventSink();
    const hub = createThreadEventHub({
      journalWriter: eventWriter,
      journalReader: eventWriter,
      eventSink,
    });
    const hubEvents: SequencedEventInternal[] = [];
    hub.subscribe(thread.id, (event) => {
      hubEvents.push(event);
    });

    const modelRequestDebug = createInMemoryModelRequestDebugStore();
    const gateway = createGateway({
      providers: [mockProviderConfig(mock.baseUrl)],
      defaultModel: "mock-llm-v1",
    });

    const orchestrator = createOrchestrator(
      createTestOrchestratorDeps({
        gateway,
        repos,
        eventWriter: hub,
        creditLedger,
        eventSink,
        modelRequestDebug,
        projectPreferences: {
          async read() {
            return { threadGroupBy: "work", pinnedThreadIds: [], defaultAgentSlug: null };
          },
        },
      }),
    );

    const handle = await orchestrator.runTurn({
      threadId: thread.id,
      userText: "hello",
      treeBudget: createDefaultTreeBudget(),
    });

    const orchestratorEvents: OrchestratorEvent[] = [];
    for await (const event of handle.events) {
      orchestratorEvents.push(event);
    }

    const debugRecords = modelRequestDebug.listByTurn(thread.id, handle.assistantTurnId);
    expect(debugRecords.length).toBeGreaterThanOrEqual(1);
    expect(debugRecords[0]?.systemMessages.join("\n")).toContain(LEAK_PROBE_MARKER);

    expectMarkerAbsent("orchestrator yield stream", orchestratorEvents);
    expectMarkerAbsent("event journal", eventWriter.getEvents(thread.id));
    expectMarkerAbsent("thread event hub fan-out", hubEvents);
    expectMarkerAbsent("EventSink payloads", eventSink.events);

    const snapshot = await buildThreadSnapshot(
      repos,
      hub,
      { getRunningTurnId: () => null },
      thread.id,
      "user-1",
    );
    // Thread entity carries the configured systemPrompt by design; leak guard covers
    // turn/block/live paths where verbatim capture must not surface.
    expectMarkerAbsent("thread snapshot turns and live state", {
      turns: snapshot.turns,
      liveState: snapshot.liveState,
      attention: snapshot.attention,
      nextSeq: snapshot.nextSeq,
    });
  });
});
