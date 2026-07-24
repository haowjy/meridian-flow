import { toDocHandle } from "@meridian/agent-edit";
import type { ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createInMemoryJournal } from "../adapters/in-memory/agent-edit.js";
import { createBranchAgentEditJournal } from "./branch-agent-edit.js";

const THREAD_ID = "00000000-0000-4000-8000-000000000003" as ThreadId;

describe("branch agent-edit journal appendBatch", () => {
  it("reports staged for thread-peer branch writes", async () => {
    const liveJournal = createInMemoryJournal();
    const branchJournal = createBranchAgentEditJournal({
      threadId: THREAD_ID,
      liveJournal,
    });
    const [result] = await branchJournal.appendBatch([
      {
        docId: "chapter.md",
        update: new Uint8Array([1, 2]),
        meta: { origin: "agent:turn-1", seq: 1 },
        mutation: {
          actorKind: "agent",
          mode: "threadPeer",
          threadId: THREAD_ID,
          turnId: "turn-1",
          branchGeneration: 1,
          writeId: "thread-peer-1:turn-1:1",
          wId: 1,
        },
      },
    ]);
    expect(result.journalCommitKind).toBe("staged");
  });

  it("classifies roots absent from live authority as agent-owned branch content", async () => {
    const liveJournal = createInMemoryJournal();
    const materialize = vi.fn(async (input: { fallbackProvenance?: string }) => ({
      before: [],
      afterCandidate: [],
      fallback: input.fallbackProvenance,
    }));
    liveJournal.materializeDestructiveProvenance = materialize;
    const branchJournal = createBranchAgentEditJournal({
      threadId: THREAD_ID,
      liveJournal,
    });
    const doc = new Y.Doc({ gc: false });

    await branchJournal.materializeDestructiveProvenance?.({
      docId: "chapter.md",
      before: toDocHandle(doc),
      afterCandidate: toDocHandle(doc),
    });

    expect(materialize).toHaveBeenCalledWith(
      expect.objectContaining({ fallbackProvenance: "agent" }),
    );
    doc.destroy();
  });
});
