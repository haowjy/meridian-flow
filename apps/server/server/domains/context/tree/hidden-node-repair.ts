/**
 * Repair on touch from reads (contract §12.4): a hidden, live document no active draft
 * uses can only come from a bug (create and use commit together, and so do end of use
 * and tombstone). `identityStatus` answers `gone` for one and schedules its repair here,
 * after the read and in its own transaction: the source's namespace, the document's lock,
 * revalidation, then the tombstone with its storage release. Each repair is a warn event.
 */
import type { DocumentId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import {
  runAfterDrizzleCommit,
  runInRootDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import { type DetachedWorkTracker, processDetachedWork } from "../../runtime/detached-work.js";
import type { ObjectRelease } from "../../storage/index.js";
import { lockDocumentNamespaces } from "../adapters/context-fs/document-locations.js";
import { type EndedUse, tombstoneUnused } from "./end-use.js";

export type HiddenNodeRepair = {
  /** Repair these documents after the caller's transaction commits (or now, outside one). */
  schedule(documentIds: readonly DocumentId[]): void;
  /** Repair them now, in a root transaction of its own. */
  repairUnused(documentIds: readonly DocumentId[]): Promise<EndedUse>;
};

const SOURCE = "context.hidden-node";

export function createHiddenNodeRepair(deps: {
  db: Database;
  eventSink?: EventSink;
  objects?: Pick<ObjectRelease, "storageUrls">;
  /** Where the detached repair is tracked, so shutdown and test resets drain it. */
  backgroundTasks?: DetachedWorkTracker;
}): HiddenNodeRepair {
  const tasks = deps.backgroundTasks ?? processDetachedWork;
  async function repairUnused(documentIds: readonly DocumentId[]): Promise<EndedUse> {
    const ids = [...new Set(documentIds)].sort();
    if (ids.length === 0) return { tombstoned: [], releasedObjects: [] };
    const ended = await runInRootDrizzleTransaction(deps.db, async () => {
      await lockDocumentNamespaces(deps.db, ids);
      return tombstoneUnused(deps.db, ids);
    });
    if (ended.tombstoned.length > 0 && deps.eventSink) {
      emitEvent(deps.eventSink, {
        level: "warn",
        source: SOURCE,
        name: "repaired",
        payload: {
          documentIds: ended.tombstoned.flatMap((ref) => (ref.kind === "document" ? [ref.id] : [])),
          folderIds: ended.tombstoned.flatMap((ref) => (ref.kind === "folder" ? [ref.id] : [])),
        },
      });
    }
    await deps.objects?.storageUrls(ended.releasedObjects);
    return ended;
  }

  return {
    repairUnused,
    schedule(documentIds) {
      if (documentIds.length === 0) return;
      runAfterDrizzleCommit(() =>
        tasks.track(
          repairUnused(documentIds).then(
            () => undefined,
            (cause: unknown) => {
              if (!deps.eventSink) return;
              emitEvent(deps.eventSink, {
                level: "warn",
                source: SOURCE,
                name: "repair.failed",
                payload: { documentIds: [...documentIds], ...unknownToEventPayload(cause) },
              });
            },
          ),
          "hidden-node repair",
        ),
      );
    },
  };
}
