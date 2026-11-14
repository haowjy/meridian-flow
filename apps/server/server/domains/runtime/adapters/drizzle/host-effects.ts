/** The runtime's outbox: effects are inserted in the transaction that owes them and delivered after it. */

import type { JsonValue } from "@meridian/contracts/threads";
import { hostEffects } from "@meridian/database/schema";
import { asc, eq, lte, sql } from "drizzle-orm";
import type { DetachedWorkTracker } from "../../../../shared/detached-work.js";
import {
  currentDrizzleDb,
  type DrizzleDatabase,
  runAfterDrizzleCommit,
  runOutsideWrite,
} from "../../../../shared/drizzle-transaction.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../../observability/index.js";
import type { HostEffects } from "../../ports/host-effects.js";

/** Failed deliveries at which a row is logged as stuck, once. */
export const HOST_EFFECT_STUCK_ATTEMPTS = 5;

/** Wait before a row that has failed `attempts` times is tried again: 5s, doubling, at most 5 minutes. */
export function hostEffectBackoffMs(attempts: number): number {
  return Math.min(5_000 * 2 ** (attempts - 1), 300_000);
}

export function createHostEffectOutbox(deps: {
  db: DrizzleDatabase;
  host: HostEffects;
  eventSink: EventSink;
  backgroundTasks: DetachedWorkTracker;
}) {
  let running: Promise<number> | undefined;
  let again = false;
  let shutdown: AbortSignal | undefined;

  /**
   * Delivers each due row on its own: its lock is held while the handler runs, so another process
   * skips it, and a crash before the handler returns leaves the row. A row that throws stays with
   * `attempts` up and `next_attempt_at` pushed out, and holds back no other.
   */
  async function deliverDueRows(): Promise<number> {
    let delivered = 0;
    while (!shutdown?.aborted) {
      const tookRow = await runOutsideWrite(() =>
        deps.db.transaction(async (tx) => {
          const [row] = await tx
            .select()
            .from(hostEffects)
            .where(lte(hostEffects.nextAttemptAt, sql`now()`))
            .orderBy(asc(hostEffects.id))
            .limit(1)
            .for("update", { skipLocked: true });
          if (!row) return false;
          try {
            await deps.host.handle({
              id: String(row.id),
              threadId: row.threadId,
              kind: row.kind,
              payload: row.payload,
            });
          } catch (cause) {
            const attempts = row.attempts + 1;
            await tx
              .update(hostEffects)
              .set({
                attempts,
                nextAttemptAt: sql`now() + ${hostEffectBackoffMs(attempts)} * interval '1 millisecond'`,
              })
              .where(eq(hostEffects.id, row.id));
            if (attempts === HOST_EFFECT_STUCK_ATTEMPTS) {
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
            return true;
          }
          await tx.delete(hostEffects).where(eq(hostEffects.id, row.id));
          delivered += 1;
          return true;
        }),
      );
      if (!tookRow) break;
    }
    return delivered;
  }

  /**
   * One loop per process: a call while it runs makes it go round once more instead of starting a
   * second, so delivery holds at most two connections (the row lock and its handler's transaction).
   * `signal` is the scheduler's: once it aborts, no loop takes another row.
   */
  function deliver(signal?: AbortSignal): Promise<number> {
    if (signal) shutdown = signal;
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      let total = 0;
      try {
        for (;;) {
          again = false;
          total += await deliverDueRows();
          if (!again || shutdown?.aborted) return total;
        }
      } finally {
        running = undefined;
      }
    })();
    return running;
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
