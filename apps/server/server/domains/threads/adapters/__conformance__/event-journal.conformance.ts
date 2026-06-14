/**
 * Shared event-journal conformance: verifies every adapter exposes the same
 * JournalEntry metadata when replaying persisted orchestrator event payloads.
 * In particular, durable nested events must retain their owning turn id.
 */
import type { Turn } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import type {
  EventJournalReader,
  EventJournalWriter,
  JournalEventEnvelope,
} from "../../ports/event-journal.js";

interface EventJournalFixture {
  journalReader: EventJournalReader;
  journalWriter: EventJournalWriter;
  createTurn(): Promise<Turn>;
}

export function describeEventJournalConformance(
  name: string,
  makeFixture: () => EventJournalFixture | Promise<EventJournalFixture>,
): void {
  describe(`EventJournal conformance: ${name}`, () => {
    it("derives JournalEntry turnId from lifecycle, nested durable, and top-level events", async () => {
      const { createTurn, journalReader, journalWriter } = await makeFixture();
      const turn = await createTurn();
      const responseId = crypto.randomUUID();

      const events = [
        { type: "turn.created", turn },
        {
          type: "model.response_received",
          response: {
            id: responseId,
            turnId: turn.id,
            sequence: 1,
            provider: "openai",
            model: "gpt-test",
          },
        },
        {
          type: "block.upserted",
          block: {
            id: crypto.randomUUID(),
            turnId: turn.id,
            responseId,
            blockType: "text",
            sequence: 1,
            content: "hello",
            provider: null,
            status: "complete",
          },
        },
        {
          type: "usage",
          responseId,
          turnId: turn.id,
          inputTokens: 1,
          outputTokens: 2,
          costUsd: "0.01",
          turnCostUsd: "0.01",
        },
        { type: "block.pruned", blockId: "orphaned_block" },
      ] satisfies JournalEventEnvelope[];

      for (const event of events) {
        await journalWriter.appendEvent(turn.threadId, event);
      }

      await expect(journalReader.listByThread(turn.threadId)).resolves.toMatchObject([
        { eventType: "turn.created", turnId: turn.id },
        { eventType: "model.response_received", turnId: turn.id },
        { eventType: "block.upserted", turnId: turn.id },
        { eventType: "usage", turnId: turn.id },
        { eventType: "block.pruned", turnId: null },
      ]);
    });

    it("derives the read-model projection watermark from non-journal-only events", async () => {
      const { createTurn, journalReader, journalWriter } = await makeFixture();
      const turn = await createTurn();

      await expect(journalReader.readModelProjectionWatermark(turn.threadId)).resolves.toBe(0n);
      await journalWriter.appendEvent(turn.threadId, {
        type: "stream.delta",
        kind: "text",
        text: "not projected yet",
      });
      await journalWriter.appendEvent(turn.threadId, {
        type: "tool.executing",
        toolCallId: "call-1",
        name: "read",
      });
      await expect(journalReader.readModelProjectionWatermark(turn.threadId)).resolves.toBe(0n);

      const projectedSeq = await journalWriter.appendEvent(turn.threadId, {
        type: "turn.created",
        turn,
      });
      await journalWriter.appendEvent(turn.threadId, {
        type: "stream.delta",
        kind: "text",
        text: "must replay",
      });

      await expect(journalReader.readModelProjectionWatermark(turn.threadId)).resolves.toBe(
        projectedSeq,
      );
    });
  });
}
