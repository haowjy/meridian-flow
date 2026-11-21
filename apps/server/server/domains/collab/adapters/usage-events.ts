/**
 * How far back writers reach for the Undos history keeps, as events: they decide how much of a
 * document's history a later history view must hold. Each names one document and its project and
 * no writer, and is emitted only once the command that did it commits, outside it, so it never
 * fails or slows the Undo.
 */
import type { PressVerdict } from "@meridian/contracts/drafts";
import type { TurnId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { threads, turns } from "@meridian/database";
import { eq } from "drizzle-orm";
import { deferUntilDrizzleCommit } from "../../../shared/drizzle-transaction.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";

export type UsageEvents = {
  /** A press taken back, per document whose text it changed: how long after it was pressed. */
  pressUndone(input: {
    projectId: string;
    verdict: PressVerdict;
    pressedAt: Date;
    documentIds: readonly string[];
  }): void;
  /** A turn's card Undo that changed something, per document: how long after the turn began. */
  turnUndone(input: { threadId: string; turnId: TurnId; documentIds: readonly string[] }): void;
};

const SOURCE = "collab.usage";

export function createUsageEvents(db: Database, sink: EventSink | undefined): UsageEvents {
  if (!sink) return { pressUndone() {}, turnUndone() {} };
  const eventSink = sink;
  const afterCommit = (send: () => void | Promise<void>) => {
    // Outside a transaction it runs now, detached: an event never fails the command.
    if (!deferUntilDrizzleCommit(send))
      void Promise.resolve()
        .then(send)
        .catch((cause) =>
          emitEvent(eventSink, {
            level: "warn",
            source: SOURCE,
            name: "usage.failed",
            payload: unknownToEventPayload(cause),
          }),
        );
  };
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
