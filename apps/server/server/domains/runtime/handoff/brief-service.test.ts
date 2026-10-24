/**
 * Handoff brief orchestration releases ownership when settlement cannot start.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - failed brief settlement remains repairable (kb/decisions/agents/conversations/handoff-seed.md)
 */

import type { ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createInMemoryEventSink } from "../../observability/index.js";
import {
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
  handoffSeedMetadata,
} from "../../threads/index.js";
import { createDetachedWorkTracker } from "../detached-work.js";
import type { HeldRunClaim } from "../loop/ports.js";
import { createHandoffBriefs } from "./brief-service.js";

describe("handoff brief service", () => {
  it("leaves a pending seed repairable after its ending transaction fails", async () => {
    const repos = createInMemoryRepositories();
    const userId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const source = await repos.threads.create({ aiWriteMode: "direct", userId, projectId });
    const cutoff = await repos.turns.create({
      threadId: source.id,
      role: "assistant",
      origin: "assistant",
      status: "complete",
    });
    const { thread: destination } = await repos.threads.createDerivedPrimary({
      aiWriteMode: "direct",
      id: crypto.randomUUID(),
      userId,
      projectId,
      workId: null,
      source,
      originType: "handoff",
      originTurnId: cutoff.id,
      title: "Handoff destination",
    });
    const seed = await repos.turns.create({
      threadId: destination.id,
      role: "system",
      origin: "system",
      status: "pending",
      metadata: handoffSeedMetadata({
        sourceThreadId: source.id,
        sourceRef: source.ref ?? "c1",
        sourceTitle: source.title,
        cutoffTurnId: cutoff.id,
      }),
    });
    const held = new Set<string>();
    const runClaim = {
      async hold(threadId: ThreadId): Promise<HeldRunClaim | null> {
        if (held.has(threadId)) return null;
        held.add(threadId);
        return {
          onLost: () => () => {},
          async release() {
            held.delete(threadId);
          },
        };
      },
    };
    const backgroundTasks = createDetachedWorkTracker();
    const service = createHandoffBriefs({
      shutdown: { started: false },
      backgroundTasks,
      repos: {
        ...repos,
        async transaction<T>(_operation: () => Promise<T>): Promise<T> {
          throw new Error("ending commit failure");
        },
      },
      eventWriter: createInMemoryEventJournalWriter(repos.transactionOwner),
      eventSink: createInMemoryEventSink(),
      threadLock: { withThreadLock: (_threadId, operation) => operation() },
      runClaim,
      async wakeIfRunnable() {},
      billingUsage: {
        async canStartTurn() {
          return true;
        },
      },
      async generate() {
        return {
          outcome: {
            kind: "complete" as const,
            text: "A completed handoff brief.",
            model: "test-model",
            modelResponses: [],
            summarizer: { path: "branch" as const, segments: 1 },
          },
        };
      },
      async publishStatus() {},
      schedulePostCommit(task) {
        void task();
      },
    });

    const claim = await service.hold(destination.id);
    if (!claim) throw new Error("Expected destination claim");
    service.launchAfterCommit({ threadId: destination.id, seedTurnId: seed.id, claim });
    await backgroundTasks.drain();

    const replacement = await service.hold(destination.id);
    expect(replacement).not.toBeNull();
    await replacement?.release();
    expect(await repos.turns.findById(seed.id)).toMatchObject({ status: "pending" });
    expect(await repos.blocks.listByTurn(seed.id)).toHaveLength(0);
  });
});
