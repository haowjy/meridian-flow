// Mutation commit contracts at the journal/live projection seam.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { toDocHandle } from "../handles.js";
import type { JournalBatchAppendEntry } from "../ports/update-journal.js";
import { createMutationCommit, type SafetyGateInput } from "./mutation-commit.js";
import { blockTexts, hashAt, humanText } from "./test-support/assertions.js";
import { MemoryJournal } from "./test-support/recording-journal.js";
import {
  cloneDoc,
  codec,
  MemoryCoordinator,
  model,
  THREAD_ID,
} from "./test-support/write-tool-harness.js";

describe("mutation commit", () => {
  it("commits an immediate update to the journal and projects it to the live document once", async () => {
    const coordinator = new MemoryCoordinator({ "chapter.md": "Alpha." });
    const journal = new MemoryJournal();
    const mutationCommit = createMutationCommit({
      journal,
      coordinator,
      model,
      codec,
    });
    const runtimeDoc = cloneDoc(coordinator.require("chapter.md"));
    const beforeVector = Y.encodeStateVector(runtimeDoc);
    humanText(runtimeDoc, 0, { from: 0, to: 5 }, "Beta");
    const update = Y.encodeStateAsUpdate(runtimeDoc, beforeVector);
    let liveProjectionCount = 0;
    coordinator.require("chapter.md").on("update", () => {
      liveProjectionCount += 1;
    });

    const committed = await mutationCommit.commitImmediate({
      docId: "chapter.md",
      commandName: "replace",
      runtime: { doc: runtimeDoc },
      updates: [
        {
          update,
          meta: { origin: "agent:turn-immediate", actorTurnId: "turn-immediate", seq: 0 },
          mutation: {
            mode: "threadPeer",
            threadId: THREAD_ID,
            turnId: "turn-immediate",
            branchGeneration: 1,
          },
        },
      ],
      afterOwnVector: Y.encodeStateVector(runtimeDoc),
      liveOrigin: { type: "agent", actorTurnId: "turn-immediate" },
      touchedHashes: new Set(),
      deletedHashes: new Set(),
      preOwnSnapshot: Y.encodeStateAsUpdate(coordinator.require("chapter.md")),
      turnId: "turn-immediate",
    });

    expect(committed.ok).toBe(true);
    expect((await journal.read("chapter.md")).updates).toHaveLength(1);
    expect(blockTexts(coordinator.require("chapter.md"))).toEqual(["Beta."]);
    expect(liveProjectionCount).toBe(1);
  });

  it("rejects a destructive immediate mutation before journaling", async () => {
    const fixture = destructiveFixture();
    humanText(fixture.coordinator.require("chapter.md"), 0, { from: 0, to: 0 }, "Writer: ");

    const result = await fixture.mutationCommit.syncAfterLocalMutation({
      ...fixture.input,
      commandName: "replace",
      before: [],
      touchedHashes: new Set(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected destructive rejection");
    expect(result.response.status).toBe("destructive_write_rejected");
    expect(result.response.text).toContain(fixture.deletedHash);
    expect(result.journalCommitKind).toBeNull();
    expect(fixture.journal.recordedBatches()).toEqual([]);
    expect(blockTexts(fixture.coordinator.require("chapter.md"))).toEqual([
      "Writer: Alpha.",
      "Beta.",
    ]);
  });

  it("reports a deterministic late destructive hit and still applies after journal commit", async () => {
    const fixture = destructiveFixture();
    let preflight: Awaited<ReturnType<typeof fixture.mutationCommit.preflightSafetyGate>>;
    preflight = await fixture.coordinator.withDocument("chapter.md", (liveDoc) =>
      fixture.mutationCommit.preflightSafetyGate(liveDoc, fixture.input),
    );
    expect(preflight.verdict).toBe("pass");
    if (preflight.verdict !== "pass") throw new Error("preflight unexpectedly rejected");

    await fixture.journal.appendBatch([fixture.journalEntry]);
    humanText(fixture.coordinator.require("chapter.md"), 0, { from: 0, to: 0 }, "Writer: ");
    const applied = await fixture.coordinator.withDocument("chapter.md", (liveDoc) =>
      fixture.mutationCommit.applyCommittedUpdateWithRecheck(
        liveDoc,
        { ...fixture.input, update: fixture.input.update, liveOrigin: fixture.input.liveOrigin },
        preflight.concurrent,
      ),
    );

    expect(applied.lateSweep).toEqual({
      affectedBlockHashes: [fixture.deletedHash],
      sweptContent: true,
      beforeContentRef: 41,
    });
    expect(blockTexts(fixture.coordinator.require("chapter.md"))).toEqual(["Beta."]);
    expect(fixture.journal.recordedBatches()).toHaveLength(1);
  });

  it("holds gate, journal append, and live apply in one coordinator callback", async () => {
    const coordinator = new RecordingCoordinator({ "chapter.md": "Alpha." });
    const journal = new DepthRecordingJournal(coordinator);
    const mutationCommit = createMutationCommit({ journal, coordinator, model, codec });
    const runtimeDoc = cloneDoc(coordinator.require("chapter.md"));
    const preOwnSnapshot = Y.encodeStateAsUpdate(runtimeDoc);
    const beforeVector = Y.encodeStateVector(runtimeDoc);
    humanText(runtimeDoc, 0, { from: 0, to: 5 }, "Beta");
    coordinator.concurrentUpdatesSince = async () => {
      coordinator.events.push(`gate:${coordinator.depth}`);
      return [];
    };
    coordinator.require("chapter.md").on("update", () => {
      coordinator.events.push(`apply:${coordinator.depth}`);
    });

    const result = await mutationCommit.commitImmediate({
      docId: "chapter.md",
      commandName: "replace",
      runtime: { doc: runtimeDoc },
      updates: [journalEntry(Y.encodeStateAsUpdate(runtimeDoc, beforeVector))],
      afterOwnVector: Y.encodeStateVector(runtimeDoc),
      liveOrigin: { type: "agent", actorTurnId: "turn-lock" },
      touchedHashes: new Set([hashAt(runtimeDoc, 0)]),
      deletedHashes: new Set(),
      preOwnSnapshot,
      turnId: "turn-lock",
    });

    expect(result.ok).toBe(true);
    expect(coordinator.acquisitions).toBe(1);
    expect(coordinator.events).toEqual(["gate:1", "journal:1", "apply:1"]);
  });
});

function destructiveFixture() {
  const coordinator = new MemoryCoordinator({ "chapter.md": "Alpha.\n\nBeta." });
  const journal = new MemoryJournal();
  const mutationCommit = createMutationCommit({ journal, coordinator, model, codec });
  const baseline = coordinator.require("chapter.md");
  const deletedHash = hashAt(baseline, 0);
  const runtimeDoc = cloneDoc(baseline);
  const preOwnSnapshot = Y.encodeStateAsUpdate(runtimeDoc);
  const beforeVector = Y.encodeStateVector(runtimeDoc);
  model.transact(
    toDocHandle(runtimeDoc),
    () => model.deleteBlock(toDocHandle(runtimeDoc), model.getBlocks(toDocHandle(runtimeDoc))[0]),
    { type: "agent", actorTurnId: "turn-delete" },
  );
  const update = Y.encodeStateAsUpdate(runtimeDoc, beforeVector);
  const entry = journalEntry(update);
  const input: SafetyGateInput & {
    update: Uint8Array;
    liveOrigin: { type: "agent"; actorTurnId: string };
    meta: JournalBatchAppendEntry["meta"];
    mutation: NonNullable<JournalBatchAppendEntry["mutation"]>;
    ownTurnId: string;
    commandName: "replace";
  } = {
    docId: "chapter.md",
    runtime: { doc: runtimeDoc },
    update,
    afterOwnVector: Y.encodeStateVector(runtimeDoc),
    deletedHashes: new Set([deletedHash]),
    preOwnSnapshot,
    interactionContext: { mode: "live", afterJournalId: 41 },
    liveOrigin: { type: "agent", actorTurnId: "turn-delete" },
    meta: entry.meta,
    mutation: entry.mutation as NonNullable<JournalBatchAppendEntry["mutation"]>,
    ownTurnId: "turn-delete",
    commandName: "replace",
  };
  return { coordinator, journal, mutationCommit, input, journalEntry: entry, deletedHash };
}

function journalEntry(update: Uint8Array): JournalBatchAppendEntry {
  return {
    docId: "chapter.md",
    update,
    meta: { origin: "agent:turn-lock", actorTurnId: "turn-lock", seq: 0 },
    mutation: {
      mode: "threadPeer",
      threadId: THREAD_ID,
      turnId: "turn-lock",
      branchGeneration: 1,
    },
  };
}

class RecordingCoordinator extends MemoryCoordinator {
  depth = 0;
  acquisitions = 0;
  readonly events: string[] = [];

  override async withDocument<T>(docId: string, fn: (doc: Y.Doc) => Promise<T>): Promise<T> {
    this.acquisitions += 1;
    this.depth += 1;
    try {
      return await super.withDocument(docId, fn);
    } finally {
      this.depth -= 1;
    }
  }
}

class DepthRecordingJournal extends MemoryJournal {
  constructor(private readonly coordinator: RecordingCoordinator) {
    super();
  }

  override async appendBatch(entries: readonly JournalBatchAppendEntry[]) {
    this.coordinator.events.push(`journal:${this.coordinator.depth}`);
    return super.appendBatch(entries);
  }
}
