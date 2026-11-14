/** The runtime's outbox: effects are inserted in the transaction that owes them and delivered after it. */

import type { JsonValue } from "@meridian/contracts/threads";
import { hostEffects } from "@meridian/database/schema";
import { asc, eq, gt } from "drizzle-orm";
import type { DetachedWorkTracker } from "../../../../shared/detached-work.js";
import {
  currentDrizzleDb,
  type DrizzleDatabase,
  runAfterDrizzleCommit,
  runOutsideWrite,
} from "../../../../shared/drizzle-transaction.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../../observability/index.js";
import type { HostEffects } from "../../ports/host-effects.js";

/** Failed deliveries after which a row is logged as stuck, on each further failure. */
export const HOST_EFFECT_STUCK_ATTEMPTS = 5;

export function createHostEffectOutbox(deps: {
  db: DrizzleDatabase;
  host: HostEffects;
  eventSink: EventSink;
  backgroundTasks: DetachedWorkTracker;
}) {
  /**
   * Delivers each row on its own: its lock is held while the handler runs, so a second process
   * skips it, and a crash before the handler returns leaves the row. A row that throws stays
   * with `attempts` up and does not hold back the others; it is tried again on the next call.
   */
  async function deliver(): Promise<number> {
    let delivered = 0;
    let after = 0;
    for (;;) {
      const step = await runOutsideWrite(() =>
        deps.db.transaction(async (tx) => {
          const [row] = await tx
            .select()
            .from(hostEffects)
            .where(gt(hostEffects.id, after))
            .orderBy(asc(hostEffects.id))
            .limit(1)
            .for("update", { skipLocked: true });
          if (!row) return null;
          try {
            await deps.host.handle({
              id: String(row.id),
              threadId: row.threadId,
              kind: row.kind,
              payload: row.payload,
            });
          } catch (cause) {
            const attempts = row.attempts + 1;
            await tx.update(hostEffects).set({ attempts }).where(eq(hostEffects.id, row.id));
            if (attempts >= HOST_EFFECT_STUCK_ATTEMPTS) {
              emitEvent(deps.eventSink, {
                level: "error",
                source: "runtime.host_effects",
                name: "effect.stuck",
                payload: {
                  effectId: row.id,
                  kind: row.kind,
                  threadId: row.threadId,
                  attempts,
                  ...unknownToEventPayload(cause),
                },
              });
            }
            return { id: row.id, delivered: false };
          }
          await tx.delete(hostEffects).where(eq(hostEffects.id, row.id));
          return { id: row.id, delivered: true };
        }),
      );
      if (!step) return delivered;
      after = step.id;
      if (step.delivered) delivered += 1;
    }
  }

  return {
    deliver,
    /** Inserts the row in the caller's transaction; delivery starts once that commits. */
    async record(threadId: string, kind: string, payload: JsonValue): Promise<void> {
      await currentDrizzleDb(deps.db)
        .insert(hostEffects)
        .values({ threadId: threadId as never, kind, payload });
      runAfterDrizzleCommit(() => {
        void deps.backgroundTasks.track(
          deliver().catch((cause) =>
            emitEvent(deps.eventSink, {
              level: "error",
              source: "runtime.host_effects",
              name: "delivery.failed",
              payload: unknownToEventPayload(cause),
            }),
          ),
          "host effects delivery",
        );
      });
    },
  };
}

export type HostEffectOutbox = ReturnType<typeof createHostEffectOutbox>;
