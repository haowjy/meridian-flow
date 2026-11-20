/** The collab domain's room transport: the live rooms behind one service. */
import type { Hocuspocus } from "@hocuspocus/server";
import type { UpdateMeta } from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { EventSink } from "../observability/index.js";
import type { CollabTransport, UpdateOrigin } from "./contracts.js";
import type { CheckpointJournal } from "./domain/ports/checkpoint-authority.js";
import type { LiveWriterJournal } from "./domain/ports/live-writer-journal.js";
import { createLiveRoom, type LiveRoom } from "./live-room.js";
import { createWriterQueue } from "./writer-queue.js";

type HocuspocusPersistenceDeps = {
  journal: CheckpointJournal & LiveWriterJournal;
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
};

export type HocuspocusPersistenceService = Pick<
  CollabTransport,
  | "loadHocuspocusDocument"
  | "admitLiveWriterUpdate"
  | "currentLiveGeneration"
  | "validateHocuspocusDocument"
  | "storeHocuspocusDocument"
  | "drainHocuspocusPersistence"
  | "getPersistenceQueueMetrics"
> &
  Pick<LiveRoom, "disconnectLiveGeneration">;

export function createHocuspocusPersistenceService(
  deps: HocuspocusPersistenceDeps,
): HocuspocusPersistenceService {
  const queue = createWriterQueue(deps);
  const live = createLiveRoom({
    ...deps,
    queue,
    afterCallerCommit: deps.afterCallerCommit ?? ((callback) => callback()),
  });
  return {
    ...live,
    async drainHocuspocusPersistence() {
      await queue.drain();
      await live.drainCheckpoints();
    },
    getPersistenceQueueMetrics: queue.metrics,
  };
}
