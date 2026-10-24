/**
 * Tests draft agent edit journal behavior.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Concurrent logical writes reserve unique ordinals
 */
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

    const ordinals = await Promise.all([
      draftJournal.reserveWriteOrdinal("chapter.md", THREAD_ID),
      draftJournal.reserveWriteOrdinal("chapter.md", THREAD_ID),
    ]);
    expect(new Set(ordinals)).toHaveLength(2);
  });
});
