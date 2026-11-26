import type { ClosedOwnerWhy } from "@meridian/contracts/commands";
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
  const value = JSON.parse(payload) as {
    workId?: unknown;
    rootThreadId?: unknown;
    projectId?: unknown;
    documentId?: unknown;
    closed?: ClosedOwnerWhy;
  };
  if (typeof value.workId === "string")
    return { workId: value.workId as WorkId, closed: value.closed };
  if (typeof value.rootThreadId === "string")
    return { rootThreadId: value.rootThreadId, closed: value.closed };
  if (typeof value.projectId === "string") return { projectId: value.projectId };
  if (typeof value.documentId === "string") return { documentId: value.documentId };
  throw new Error("Malformed file access change");
}
