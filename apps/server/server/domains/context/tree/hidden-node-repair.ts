/**
 * Repair on touch (contract §12.4): a hidden, live document no active draft uses can only
 * come from a bug (create and use commit together, and so do end of use and tombstone).
 * A read that meets one (`identityStatus` answering `gone`) schedules its repair here,
 * after the read and in its own transaction: the verified end-use scope (namespaces, a
 * re-read, document locks), revalidation, then the tombstone with its storage release. A
 * create's candidate picker repairs in its own transaction and reports it here. Either
 * way, each repair is a `context.hidden-node.repaired` warn event once it commits.
 */
import type { DocumentId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import {
  runAfterDrizzleCommit,
  runInRootDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import {
  type EventSink,
  emitEvent,
  joinIds,
  unknownToEventPayload,
} from "../../observability/index.js";
import { type DetachedWorkTracker, processDetachedWork } from "../../runtime/detached-work.js";
import type { ObjectRelease } from "../../storage/index.js";
import {
  acquireEndUseScope,
  type EndedUse,
  EndUseScopeChangedError,
  tombstoneUnused,
} from "./end-use.js";

export type HiddenNodeRepair = {
  /** Repair these documents after the caller's transaction commits (or now, outside one). */
  schedule(documentIds: readonly DocumentId[]): void;
  /** Repair them now, in a root transaction of its own. */
  repairUnused(documentIds: readonly DocumentId[]): Promise<EndedUse>;
  /**
   * A repair the caller made in its own transaction (a create's candidate picker): warned
   * about, and its objects released, once that transaction commits; nothing on rollback.
   */
  report(ended: EndedUse, trigger: "create"): void;
};

const SOURCE = "context.hidden-node";
/** A scope that keeps moving under a repair: give up and let the next touch try again. */
const ATTEMPTS = 3;

export function createHiddenNodeRepair(deps: {
  db: Database;
  eventSink?: EventSink;
  objects?: Pick<ObjectRelease, "storageUrls">;
  /** Where the detached repair is tracked, so shutdown and test resets drain it. */
  backgroundTasks?: DetachedWorkTracker;
}): HiddenNodeRepair {
  const tasks = deps.backgroundTasks ?? processDetachedWork;

  /** After commit: the warning, then the objects. */
  async function repaired(ended: EndedUse, trigger: "read" | "create"): Promise<void> {
    if (ended.tombstoned.length === 0) return;
    if (deps.eventSink) {
      emitEvent(deps.eventSink, {
        level: "warn",
        source: SOURCE,
        name: "repaired",
        correlation: {
          folderIds: joinIds(
            ended.tombstoned.flatMap((ref) => (ref.kind === "folder" ? [ref.id] : [])),
          ),
          releasedBranchIds: joinIds(ended.releasedBranches.map((branch) => branch.branchId)),
        },
        payload: {
          trigger,
          documentIds: ended.tombstoned.flatMap((ref) => (ref.kind === "document" ? [ref.id] : [])),
        },
      });
    }
    await deps.objects?.storageUrls(ended.releasedObjects);
  }

  async function repairUnused(documentIds: readonly DocumentId[]): Promise<EndedUse> {
    const ids = [...new Set(documentIds)].sort();
    if (ids.length === 0) return { tombstoned: [], releasedObjects: [], releasedBranches: [] };
    for (let attempt = 1; ; attempt += 1) {
      try {
        const ended = await runInRootDrizzleTransaction(deps.db, async () => {
          await acquireEndUseScope(deps.db, { documentIds: ids });
          return tombstoneUnused(deps.db, ids);
        });
        await repaired(ended, "read");
        return ended;
      } catch (cause) {
        if (!(cause instanceof EndUseScopeChangedError) || attempt >= ATTEMPTS) throw cause;
      }
    }
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
    report(ended, trigger) {
      if (ended.tombstoned.length === 0) return;
      runAfterDrizzleCommit(() => tasks.track(repaired(ended, trigger), "hidden-node repair"));
    },
  };
}
