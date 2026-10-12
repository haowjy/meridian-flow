/**
 * File-access change buses: Postgres NOTIFY across instances (the transport
 * thread events already use), and an in-process bus for memory compositions.
 */
import type { WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { EventSink } from "../../observability/index.js";
import { emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { FileAccessChange, FileAccessChanges } from "../ports/file-access-changes.js";

const CHANNEL = "file_access_changed";

function listeners() {
  const set = new Set<(change: FileAccessChange) => void>();
  return {
    subscribe(listener: (change: FileAccessChange) => void) {
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
    deliver(change: FileAccessChange) {
      for (const listener of set) listener(change);
    },
  };
}

export type PgFileAccessChanges = FileAccessChanges & {
  /** Starts hearing other instances' (and this one's) committed changes. */
  listen(): Promise<{ unlisten: () => Promise<void> }>;
};

export function createPgFileAccessChanges(input: {
  db: Database;
  eventSink: EventSink;
}): PgFileAccessChanges {
  const local = listeners();
  return {
    subscribe: local.subscribe,
    async publish(change) {
      // NOTIFY inside the ambient transaction is delivered at its commit.
      await currentDrizzleDb(input.db).execute(
        sql`select pg_notify(${CHANNEL}, ${JSON.stringify(change)})`,
      );
    },
    listen() {
      return input.db.listen(CHANNEL, (payload) => {
        try {
          local.deliver(parseChange(payload));
        } catch (cause) {
          emitEvent(input.eventSink, {
            level: "error",
            source: "file-policy.access-changes",
            name: "notification.failed",
            payload: { notification: payload, ...unknownToEventPayload(cause) },
          });
        }
      });
    },
  };
}

/** One process, no transactions: a change is heard as soon as it is published. */
export function createLocalFileAccessChanges(): FileAccessChanges {
  const local = listeners();
  return {
    subscribe: local.subscribe,
    async publish(change) {
      local.deliver(change);
    },
  };
}

function parseChange(payload: string): FileAccessChange {
  const value = JSON.parse(payload) as { workId?: unknown };
  if (typeof value.workId !== "string") throw new Error("Malformed file access change");
  return { workId: value.workId as WorkId };
}
