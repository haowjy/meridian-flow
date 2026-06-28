/**
 * Turn-runner generator failure integration: a throwing event generator must
 * leave the assistant turn in a terminal error state with a journal turn.error.
 */

import { describe, expect, it } from "vitest";
import { createInMemoryCreditLedger } from "../../../billing/index.js";
import { createInMemoryEventSink } from "../../../observability/index.js";
import { createInMemoryProjectRepository } from "../../../projects/index.js";
import {
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
  createThreadEventHub,
} from "../../../threads/index.js";
import { createInertGateway } from "../../gateway/test-gateway.js";
import { createCheckpointRegistry } from "../checkpoints.js";
import { createOrchestrator } from "../orchestrator.js";
import { createTurnRunner } from "../turn-runner.js";
import { createTestOrchestratorDeps } from "./test-orchestrator-deps.js";

describe("turn-runner generator failure", () => {
  it("finalizes assistant turn as error when the generator throws mid-run", async () => {
    const projectRepo = createInMemoryProjectRepository();
    const repos = createInMemoryRepositories({ projects: projectRepo });
    const project = await projectRepo.create({ userId: "user-1", title: "WB" });
    const creditLedger = createInMemoryCreditLedger();
    const eventWriter = createInMemoryEventJournalWriter();
    const hub = createThreadEventHub({
      journalWriter: eventWriter,
      journalReader: eventWriter,
      eventSink: createInMemoryEventSink(),
    });
    const orchestrator = createOrchestrator(
      createTestOrchestratorDeps({
        gateway: createInertGateway(),
        repos,
        eventWriter: hub,
        checkpointRegistry: createCheckpointRegistry(),
        creditLedger,
        eventSink: createInMemoryEventSink(),
        projectPreferences: {
          async read() {
            throw new Error("preferences DB unavailable");
          },
        },
      }),
    );
    const runner = createTurnRunner({
      orchestrator,
      hub,
      repos: { turns: repos.turns },
      eventSink: createInMemoryEventSink(),
    });
    const thread = await repos.threads.create({ userId: "user-1", projectId: project.id });
    await creditLedger.grant({
      userId: "user-1",
      source: "manual",
      amountMillicredits: "1000000",
      reason: "generator failure test",
    });

    const started = await runner.startTurn({ threadId: thread.id, userText: "hello" });

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const turn = await repos.turns.findById(started.assistantTurnId);
      if (turn?.status === "error") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const assistantTurn = await repos.turns.findById(started.assistantTurnId);
    expect(assistantTurn?.status).toBe("error");
    expect(assistantTurn?.status).not.toBe("streaming");
    expect(
      eventWriter.getEvents(thread.id).filter((entry) => entry.event.type === "turn.error"),
    ).toHaveLength(1);
    expect(runner.getRunningTurnId(thread.id)).toBeNull();
  });
});
