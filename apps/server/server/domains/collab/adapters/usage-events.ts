import type { PressVerdict } from "@meridian/contracts/drafts";
import type { TurnId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { threads, turns } from "@meridian/database";
import { eq } from "drizzle-orm";
import { runAfterDrizzleCommit } from "../../../shared/drizzle-transaction.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";

export type UsageEvents = {
  pressUndone(input: {
    projectId: string;
    verdict: PressVerdict;
    pressedAt: Date;
    documentIds: readonly string[];
  }): void;
  turnUndone(input: { threadId: string; turnId: TurnId; documentIds: readonly string[] }): void;
};

const SOURCE = "collab.usage";

export function createUsageEvents(db: Database, sink: EventSink | undefined): UsageEvents {
  if (!sink) return { pressUndone() {}, turnUndone() {} };
  const eventSink = sink;
  const afterCommit = (send: () => void | Promise<void>) =>
    runAfterDrizzleCommit(async () => {
      try {
        await send();
      } catch (cause) {
        emitEvent(eventSink, {
          level: "warn",
          source: SOURCE,
          name: "usage.failed",
          payload: unknownToEventPayload(cause),
        });
      }
    });
  const ageSeconds = (since: Date) => Math.round((Date.now() - since.getTime()) / 1000);
  return {
    pressUndone({ projectId, verdict, pressedAt, documentIds }) {
      afterCommit(() => {
        for (const documentId of documentIds)
          emitEvent(eventSink, {
            level: "info",
            source: SOURCE,
            name: "press.undo",
            correlation: { projectId, documentId },
            payload: { verdict, ageSeconds: ageSeconds(pressedAt) },
          });
      });
    },
    turnUndone({ threadId, turnId, documentIds }) {
      afterCommit(async () => {
        const [turn] = await db
          .select({ createdAt: turns.createdAt, projectId: threads.projectId })
          .from(turns)
          .innerJoin(threads, eq(threads.id, turns.threadId))
          .where(eq(turns.id, turnId));
        if (!turn) return;
        for (const documentId of documentIds)
          emitEvent(eventSink, {
            level: "info",
            source: SOURCE,
            name: "turn.undo",
            correlation: { projectId: turn.projectId, documentId, threadId, turnId },
            payload: { ageSeconds: ageSeconds(turn.createdAt) },
          });
      });
    },
  };
}
