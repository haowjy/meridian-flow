// Mutation commit contracts at the journal/live projection seam.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { snapshotBlocks } from "../apply/echo.js";
import { toDocHandle } from "../handles.js";
import type { JournalBatchAppendEntry } from "../ports/update-journal.js";
import { createMutationCommit, type PreparedMutation } from "./mutation-commit.js";
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

    const committed = await mutationCommit.submitMutation({
      docId: "chapter.md",
      commandName: "replace",
      runtime: { doc: runtimeDoc },
      before: snapshotBlocks(toDocHandle(coordinator.require("chapter.md")), model, codec),
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
  });

  it("preserves durable acceptance when destructive reporting fails after append", async () => {
    const fixture = destructiveFixture();
    const journal: import("../ports/update-journal.js").UpdateJournal = fixture.journal;
    journal.materializeDestructiveProvenance = async () => {
      throw new Error("classification failed");
    };

    await expect(fixture.mutationCommit.submitMutation(fixture.input)).rejects.toMatchObject({
      journalCommitKind: "durable",
    });
    expect((await fixture.journal.read("chapter.md")).updates).toHaveLength(1);
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

    const result = await mutationCommit.submitMutation({
      docId: "chapter.md",
      commandName: "replace",
      runtime: { doc: runtimeDoc },
      before: snapshotBlocks(toDocHandle(coordinator.require("chapter.md")), model, codec),
      updates: [journalEntry(Y.encodeStateAsUpdate(runtimeDoc, beforeVector))],
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
    expect(coordinator.events).toEqual(["journal:1", "gate:1", "apply:1"]);
  });
});

function destructiveFixture(deleteCount = 1) {
  const coordinator = new MemoryCoordinator({ "chapter.md": "Alpha.\n\nBeta." });
  const journal = new MemoryJournal();
  const baseline = coordinator.require("chapter.md");
  const mutationCommit = createMutationCommit({
    journal,
    coordinator,
    model,
    codec,
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
  const input: PreparedMutation & { update: Uint8Array } = {
    docId: "chapter.md",
    runtime: { doc: runtimeDoc },
    before: snapshotBlocks(toDocHandle(baseline), model, codec),
    updates: [entry],
    update,
    deletedHashes: new Set(deletedHashes),
    touchedHashes: new Set(deletedHashes),
    preOwnSnapshot,
    interactionContext: { mode: "live", afterJournalId: 41 },
    liveOrigin: { type: "agent", actorTurnId: "turn-delete" },
    turnId: "turn-delete",
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
