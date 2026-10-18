import type { ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createInMemoryJournal } from "../adapters/in-memory/agent-edit.js";
import { createDraftAgentEditJournal } from "./draft-agent-edit.js";

const THREAD_ID = "00000000-0000-4000-8000-000000000003" as ThreadId;

describe("draft agent-edit journal appendBatch", () => {
  it("reserves independent ordinals for concurrent logical writes", async () => {
    const draftJournal = createDraftAgentEditJournal({
      liveJournal: createInMemoryJournal(),
    });

    await expect(
      Promise.all([
        draftJournal.reserveWriteOrdinal("chapter.md", THREAD_ID),
        draftJournal.reserveWriteOrdinal("chapter.md", THREAD_ID),
      ]),
    ).resolves.toEqual([1, 2]);
  });
});
