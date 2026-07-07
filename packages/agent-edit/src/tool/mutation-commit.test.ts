// Mutation commit contracts at the journal/live projection seam.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { createMutationCommit } from "./mutation-commit.js";
import { blockTexts, humanText } from "./test-support/assertions.js";
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
    });

    expect(committed.ok).toBe(true);
    expect((await journal.read("chapter.md")).updates).toHaveLength(1);
    expect(blockTexts(coordinator.require("chapter.md"))).toEqual(["Beta."]);
    expect(liveProjectionCount).toBe(1);
  });
});
