// Mutation commit contracts at the journal/live projection seam.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { snapshotBlocks } from "../apply/echo.js";
import { toDocHandle } from "../handles.js";
import { createStaticDocumentLinks } from "../ports/static-document-links.js";
import type { JournalBatchAppendEntry } from "../ports/update-journal.js";
import { createMutationCommit } from "./mutation-commit.js";
import { hashAt, humanText } from "./test-support/assertions.js";
import { MemoryJournal } from "./test-support/recording-journal.js";
import {
  cloneDoc,
  codec,
  codecFactory,
  MemoryCoordinator,
  model,
  THREAD_ID,
} from "./test-support/write-tool-harness.js";

const links = createStaticDocumentLinks();

describe("mutation commit", () => {
  it("holds gate, journal append, and live apply in one coordinator callback", async () => {
    const coordinator = new RecordingCoordinator({ "chapter.md": "Alpha." });
    const journal = new DepthRecordingJournal(coordinator);
    const mutationCommit = createMutationCommit({
      journal,
      coordinator,
      model,
      links,
      codec: codecFactory,
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
      links: { codec, scope: links.scopeFor("chapter.md", undefined) },
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
