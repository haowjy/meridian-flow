/** The collab domain's room transport: each room kind's module behind one service. */
import type { Hocuspocus } from "@hocuspocus/server";
import type { UpdateMeta } from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { EventSink } from "../observability/index.js";
import type { CollabTransport, UpdateOrigin } from "./contracts.js";
import type { DraftCoordinator } from "./domain/draft-coordinator.js";
import type { DraftStore } from "./domain/draft-store.js";
import type { CheckpointJournal } from "./domain/ports/checkpoint-authority.js";
import type { LiveWriterJournal } from "./domain/ports/live-writer-journal.js";
import { createDraftRoom, type DraftRoom } from "./draft-room.js";
import { createLiveRoom, type LiveRoom } from "./live-room.js";
import { createWriterQueue } from "./writer-queue.js";

type HocuspocusPersistenceDeps = {
  journal: CheckpointJournal & LiveWriterJournal;
  draftStore?: DraftStore;
  draftCoordinator?: DraftCoordinator;
  hocuspocus(): Hocuspocus | null;
  eventSink?: EventSink;
  metaForOrigin(origin: UpdateOrigin): UpdateMeta;
  /**
   * Runs `callback` once the caller's ambient DB transaction commits, outside
   * it, and drops it on rollback; with no ambient transaction it runs now.
   * Defaults to running now, for adapters without transactions.
   */
  afterCallerCommit?(callback: () => void): void;
  readAuthorityHeadGeneration?(documentId: DocumentId): Promise<bigint>;
  emitAgentEditInvariantViolation(payload: Record<string, unknown>): void;
  /** Brings Live's committed text into a draft whose room just took a connection. */
  catchUpOpenedDraft?(draftId: string): Promise<void>;
  /** A writer's update to a draft is durable (the draft's own links register, §10.7). */
  onDraftWriterUpdateAdmitted?(draftId: string): void;
};

export type HocuspocusPersistenceService = Pick<
  CollabTransport,
  | "resolveDraftHocuspocusRoom"
  | "draftExists"
  | "openDraftIds"
  | "openDraftRooms"
  | "loadHocuspocusDocument"
  | "loadHocuspocusDraftState"
  | "admitLiveWriterUpdate"
  | "currentLiveGeneration"
  | "validateHocuspocusDocument"
  | "admitDraftWriterUpdate"
  | "storeHocuspocusDocument"
  | "storeHocuspocusDraft"
  | "drainHocuspocusPersistence"
  | "drainHocuspocusDraftPersistence"
  | "closeHocuspocusDraftRoom"
  | "connectedHocuspocusDraftRoom"
  | "unloadedHocuspocusDraftRoom"
  | "getPersistenceQueueMetrics"
> &
  Pick<LiveRoom, "disconnectLiveGeneration"> &
  Pick<DraftRoom, "catchUp">;

/** A dependency this adapter was composed without: it throws when first used. */
function absent<T extends object>(what: string): T {
  return new Proxy({} as T, {
    get() {
      throw new Error(`Draft Hocuspocus rooms require ${what}`);
    },
  });
}

export function createHocuspocusPersistenceService(
  deps: HocuspocusPersistenceDeps,
): HocuspocusPersistenceService {
  const queue = createWriterQueue(deps);
  const live = createLiveRoom({
    ...deps,
    queue,
    afterCallerCommit: deps.afterCallerCommit ?? ((callback) => callback()),
  });
  const draft = createDraftRoom({
    ...deps,
    store: deps.draftStore ?? absent("a draft store"),
    coordinator: deps.draftCoordinator ?? absent("a draft coordinator"),
    queue,
    onWriterAdmitted: deps.onDraftWriterUpdateAdmitted,
  });
  return {
    ...live,
    ...draft,
    async drainHocuspocusPersistence() {
      await queue.drain();
      await live.drainCheckpoints();
    },
    getPersistenceQueueMetrics: queue.metrics,
  };
}
