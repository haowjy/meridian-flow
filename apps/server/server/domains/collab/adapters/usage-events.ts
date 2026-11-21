/**
 * How far back writers reach for the Undos history keeps, as events: they decide how much of a
 * document's history a later history view must hold. Each names the project or the document and
 * no writer, and is emitted only once the command that did it commits.
 */
import type { PressVerdict } from "@meridian/contracts/drafts";
import type { TurnId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { turns } from "@meridian/database";
import { eq } from "drizzle-orm";
import { currentDrizzleDb, deferUntilDrizzleCommit } from "../../../shared/drizzle-transaction.js";
import { type EventSink, emitEvent } from "../../observability/index.js";

export type UsageEvents = {
  /** A press taken back: how long after it was pressed, and which verdict. */
  pressUndone(input: {
    projectId: string;
    verdict: PressVerdict;
    pressedAt: Date;
    documents: number;
  }): void;
  /** A turn's card Undo that changed something: how long after the turn began. */
  turnUndone(input: { threadId: string; turnId: TurnId }): Promise<void>;
};

const SOURCE = "collab.usage";

export function createUsageEvents(db: Database, eventSink: EventSink | undefined): UsageEvents {
  const emit = (event: Parameters<typeof emitEvent>[1]) => {
    if (!eventSink) return;
    const send = () => emitEvent(eventSink, event);
    if (!deferUntilDrizzleCommit(send)) send();
  };
  const ageSeconds = (since: Date) => Math.round((Date.now() - since.getTime()) / 1000);
  return {
    pressUndone({ projectId, verdict, pressedAt, documents }) {
      emit({
        level: "info",
        source: SOURCE,
        name: "press.undo",
        correlation: { projectId },
        payload: { verdict, ageSeconds: ageSeconds(pressedAt), documents },
      });
    },
    async turnUndone({ threadId, turnId }) {
      if (!eventSink) return;
      const [turn] = await currentDrizzleDb(db)
        .select({ createdAt: turns.createdAt })
        .from(turns)
        .where(eq(turns.id, turnId));
      if (!turn) return;
      emit({
        level: "info",
        source: SOURCE,
        name: "turn.undo",
        correlation: { threadId, turnId },
        payload: { ageSeconds: ageSeconds(turn.createdAt) },
      });
    },
  };
}
