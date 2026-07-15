// Mutation commit contracts at the journal/live projection seam.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { snapshotBlocks } from "../apply/echo.js";
import { toDocHandle } from "../handles.js";
import { digestRenderedContent } from "../observation-snapshot.js";
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
  it("looks up response observation by full document-scoped Yjs identity", async () => {
    const coordinator = new MemoryCoordinator({ "chapter.md": "Alpha." });
    const journal = new MemoryJournal();
    const mutationCommit = createMutationCommit({
      journal,
      coordinator,
      model,
      codec,
      observationSnapshots: {
        async seal() {},
        async load(responseId) {
          return {
            responseId,
            entries: [
              {
                documentId: "chapter.md",
                clientID: 4_294_967_295,
                clock: 21,
                value: { kind: "rendered", digest: "sha256:full-identity" },
              },
            ],
          };
        },
      },
    });

    await expect(
      mutationCommit.lookupObservation("response-1", {
        documentId: "chapter.md",
        clientID: 4_294_967_295,
        clock: 21,
      }),
    ).resolves.toEqual({ kind: "rendered", digest: "sha256:full-identity" });
    await expect(
      mutationCommit.lookupObservation("response-1", {
        documentId: "chapter.md",
        clientID: 4_294_967_295,
        clock: 22,
      }),
    ).resolves.toBeNull();
  });

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
            actorKind: "agent",
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
      actor: {
        kind: "agent",
        turnId: "turn-immediate",
        threadId: THREAD_ID,
        responseId: "response-immediate",
      },
    });

    expect(committed.ok).toBe(true);
    expect((await journal.read("chapter.md")).updates).toHaveLength(1);
    expect(blockTexts(coordinator.require("chapter.md"))).toEqual(["Beta."]);
    expect(liveProjectionCount).toBe(1);
    if (!committed.ok) throw new Error("expected commit success");
    if (!committed.observationCut) throw new Error("expected atomic observation cut");
    expect(committed.observationCut.liveBefore.map((block) => block.serialized)).toEqual([
      expect.stringContaining("Alpha."),
    ]);
    expect(committed.observationCut.liveAfter.map((block) => block.serialized)).toEqual([
      expect.stringContaining("Beta."),
    ]);
    expect(Object.isFrozen(committed.observationCut)).toBe(true);
    expect(Object.isFrozen(committed.observationCut.liveBefore)).toBe(true);
  });

  it("S9: does not report a destructive mutation over another agent's block", async () => {
    const fixture = destructiveFixture();
    humanText(fixture.coordinator.require("chapter.md"), 0, { from: 0, to: 0 }, "Peer: ");
    returnConcurrentUpdateAs(fixture, { type: "agent", actorTurnId: "turn-peer" });

    const result = await fixture.mutationCommit.syncAfterLocalMutation({
      ...fixture.input,
      commandName: "replace",
      before: [],
      touchedHashes: new Set(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected commit success");
    expect(result.lateSweep).toBeUndefined();
    expect(fixture.journal.recordedBatches()).toHaveLength(1);
    expect(blockTexts(fixture.coordinator.require("chapter.md"))).toEqual(["Beta."]);
  });

  it("reports an unjournaled WS edit that lands during syncAfterLocalMutation journal append", async () => {
    const fixture = destructiveFixture();
    const append = fixture.journal.appendBatch.bind(fixture.journal);
    fixture.journal.appendBatch = async (entries) => {
      humanText(fixture.coordinator.require("chapter.md"), 0, { from: 0, to: 0 }, "WS: ");
      await Promise.resolve();
      return append(entries);
    };

    const result = await fixture.mutationCommit.syncAfterLocalMutation({
      ...fixture.input,
      commandName: "replace",
      before: [],
      touchedHashes: new Set(),
    });

    expect(result).toMatchObject({
      ok: true,
      lateSweep: {
        affectedBlockHashes: [fixture.deletedHash],
        capturedDeletedBodies: [{ hash: fixture.deletedHash, body: "WS: Alpha." }],
      },
    });
    expect(blockTexts(fixture.coordinator.require("chapter.md"))).toEqual(["Beta."]);
  });

  it("reports an unjournaled WS edit that lands during commitImmediate journal append", async () => {
    const fixture = destructiveFixture();
    const append = fixture.journal.appendBatch.bind(fixture.journal);
    fixture.journal.appendBatch = async (entries) => {
      humanText(fixture.coordinator.require("chapter.md"), 0, { from: 0, to: 0 }, "WS: ");
      await Promise.resolve();
      return append(entries);
    };

    const result = await fixture.mutationCommit.commitImmediate({
      ...fixture.input,
      updates: [fixture.journalEntry],
      touchedHashes: new Set(),
      turnId: fixture.input.ownTurnId,
    });

    expect(result).toMatchObject({
      ok: true,
      concurrentUpdates: [],
      lateSweep: {
        affectedBlockHashes: [fixture.deletedHash],
        capturedDeletedBodies: [{ hash: fixture.deletedHash, body: "WS: Alpha." }],
      },
    });
    expect(blockTexts(fixture.coordinator.require("chapter.md"))).toEqual(["Beta."]);
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
      capturedDeletedBodies: [{ hash: fixture.deletedHash, body: "Writer: Alpha." }],
      sweptContent: true,
      beforeContentRef: 41,
    });
    expect(blockTexts(fixture.coordinator.require("chapter.md"))).toEqual(["Beta."]);
    expect(fixture.journal.recordedBatches()).toHaveLength(1);
  });

  it("detects an unjournaled live edit that lands during the phase-C await", async () => {
    const fixture = destructiveFixture();
    const preflight = await fixture.coordinator.withDocument("chapter.md", (liveDoc) =>
      fixture.mutationCommit.preflightSafetyGate(liveDoc, fixture.input),
    );
    expect(preflight.verdict).toBe("pass");
    if (preflight.verdict !== "pass") throw new Error("preflight unexpectedly rejected");

    fixture.coordinator.concurrentUpdatesSince = async () => {
      // A Hocuspocus update is already in the shared Y.Doc but has not reached
      // the journal-backed concurrentUpdatesSince adapter yet.
      humanText(fixture.coordinator.require("chapter.md"), 0, { from: 0, to: 0 }, "WS: ");
      await Promise.resolve();
      return [];
    };
    const applied = await fixture.coordinator.withDocument("chapter.md", (liveDoc) =>
      fixture.mutationCommit.applyCommittedUpdateWithRecheck(
        liveDoc,
        { ...fixture.input, update: fixture.input.update, liveOrigin: fixture.input.liveOrigin },
        preflight.concurrent,
      ),
    );

    expect(applied.lateSweep).toEqual({
      affectedBlockHashes: [fixture.deletedHash],
      capturedDeletedBodies: [{ hash: fixture.deletedHash, body: "WS: Alpha." }],
      sweptContent: true,
      beforeContentRef: 41,
    });
    expect(blockTexts(fixture.coordinator.require("chapter.md"))).toEqual(["Beta."]);
  });

  it("does not report a late sweep when another agent edits the deleted block", async () => {
    const fixture = destructiveFixture();
    const preflight = await fixture.coordinator.withDocument("chapter.md", (liveDoc) =>
      fixture.mutationCommit.preflightSafetyGate(liveDoc, fixture.input),
    );
    expect(preflight.verdict).toBe("pass");
    if (preflight.verdict !== "pass") throw new Error("preflight unexpectedly rejected");

    humanText(fixture.coordinator.require("chapter.md"), 0, { from: 0, to: 0 }, "Peer: ");
    returnConcurrentUpdateAs(fixture, { type: "agent", actorTurnId: "turn-peer" });
    const applied = await fixture.coordinator.withDocument("chapter.md", (liveDoc) =>
      fixture.mutationCommit.applyCommittedUpdateWithRecheck(
        liveDoc,
        { ...fixture.input, update: fixture.input.update, liveOrigin: fixture.input.liveOrigin },
        preflight.concurrent,
      ),
    );

    expect(applied.lateSweep).toBeUndefined();
    expect(blockTexts(fixture.coordinator.require("chapter.md"))).toEqual(["Beta."]);
  });

  it("holds gate, journal append, and live apply in one coordinator callback", async () => {
    const coordinator = new RecordingCoordinator({ "chapter.md": "Alpha." });
    const journal = new DepthRecordingJournal(coordinator);
    const mutationCommit = createMutationCommit({
      journal,
      coordinator,
      model,
      codec,
      observationSnapshots: observationStoreFor("chapter.md", coordinator.require("chapter.md")),
    });
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
      actor: {
        kind: "agent",
        turnId: "turn-lock",
        threadId: THREAD_ID,
        responseId: "response-lock",
      },
    });

    expect(result.ok).toBe(true);
    expect(coordinator.acquisitions).toBe(1);
    expect(coordinator.events).toEqual(["gate:1", "journal:1", "apply:1"]);
  });
});

function destructiveFixture(deleteCount = 1) {
  const coordinator = new MemoryCoordinator({ "chapter.md": "Alpha.\n\nBeta." });
  const journal = new MemoryJournal();
  const baseline = coordinator.require("chapter.md");
  const observations = snapshotBlocks(toDocHandle(baseline), model, codec).map((block) => ({
    documentId: "chapter.md",
    clientID: block.clientID as number,
    clock: block.clock as number,
    value: {
      kind: "rendered" as const,
      digest: digestRenderedContent(block.renderedContent as string),
    },
  }));
  const mutationCommit = createMutationCommit({
    journal,
    coordinator,
    model,
    codec,
    observationSnapshots: {
      async seal() {},
      async load(responseId) {
        return { responseId, entries: observations };
      },
    },
  });
  const deletedHashes = Array.from({ length: deleteCount }, (_, index) => hashAt(baseline, index));
  const deletedHash = deletedHashes[0];
  const runtimeDoc = cloneDoc(baseline);
  const preOwnSnapshot = Y.encodeStateAsUpdate(runtimeDoc);
  const beforeVector = Y.encodeStateVector(runtimeDoc);
  model.transact(
    toDocHandle(runtimeDoc),
    () => {
      for (let index = 0; index < deleteCount; index += 1) {
        model.deleteBlock(toDocHandle(runtimeDoc), model.getBlocks(toDocHandle(runtimeDoc))[0]);
      }
    },
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
    deletedHashes: new Set(deletedHashes),
    touchedHashes: new Set(deletedHashes),
    preOwnSnapshot,
    interactionContext: { mode: "live", afterJournalId: 41 },
    liveOrigin: { type: "agent", actorTurnId: "turn-delete" },
    meta: entry.meta,
    mutation: entry.mutation as NonNullable<JournalBatchAppendEntry["mutation"]>,
    ownTurnId: "turn-delete",
    actor: {
      kind: "agent",
      turnId: "turn-delete",
      threadId: THREAD_ID,
      responseId: "response-delete",
    },
    commandName: "replace",
  };
  return {
    coordinator,
    journal,
    mutationCommit,
    input,
    journalEntry: entry,
    deletedHash,
    deletedHashes,
  };
}

function observationStoreFor(documentId: string, doc: Y.Doc) {
  const entries = snapshotBlocks(toDocHandle(doc), model, codec).map((block) => ({
    documentId,
    clientID: block.clientID as number,
    clock: block.clock as number,
    value: {
      kind: "rendered" as const,
      digest: digestRenderedContent(block.renderedContent as string),
    },
  }));
  return {
    async seal() {},
    async load(responseId: string) {
      return { responseId, entries };
    },
  };
}

function returnConcurrentUpdateAs(
  fixture: ReturnType<typeof destructiveFixture>,
  origin: { type: "human"; userId: "human-1" } | { type: "agent"; actorTurnId: string },
): void {
  fixture.coordinator.concurrentUpdatesSince = async ({ doc, sinceStateVector }) => {
    const update = Y.encodeStateAsUpdate(doc, sinceStateVector);
    return update.length > 0 ? [{ update, origin }] : [];
  };
}

function journalEntry(update: Uint8Array): JournalBatchAppendEntry {
  return {
    docId: "chapter.md",
    update,
    meta: { origin: "agent:turn-lock", actorTurnId: "turn-lock", seq: 0 },
    mutation: {
      actorKind: "agent",
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
