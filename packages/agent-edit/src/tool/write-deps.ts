// Shared dependencies bag for the write-tool command pipeline modules.
import type * as Y from "yjs";

import type { AgentEditCodec } from "../codec-adapter.js";
import type { ActorSessionStore } from "../ports/actor-session-store.js";
import type { DocumentCoordinator } from "../ports/document-coordinator.js";
import type { DocumentLifecycle } from "../ports/document-lifecycle.js";
import type { AgentEditModel } from "../ports/model.js";
import type { ObservationSnapshotStore } from "../ports/observation-snapshot.js";
import type { SemanticProvenanceWriter } from "../ports/semantic-provenance.js";
import type { TurnDiffQuery } from "../ports/turn-diff-query.js";
import type { ReversalStore, UpdateJournal } from "../ports/update-journal.js";
import type {
  ResponseCommitterTransitionDetail,
  ResponseLifecycleClaimDiscardedDetail,
  ResponseLifecycleErrorDetail,
  WriteIdempotencyHitDetail,
} from "./types.js";
import type { ReversalNoticeFailedDetail, ReversalNoticePort } from "./write-reversal.js";

export interface CreateWriteToolOptions {
  journal: UpdateJournal & ReversalStore;
  coordinator: DocumentCoordinator;
  lifecycle?: DocumentLifecycle;
  turnDiffQuery?: TurnDiffQuery;
  codec: AgentEditCodec;
  model: AgentEditModel;
  /** Durable lookup authority for the response that authored a mutation. */
  observationSnapshots?: ObservationSnapshotStore;
  semanticProvenance?: SemanticProvenanceWriter;
  actorSessionStore?: ActorSessionStore;
  idempotency?: {
    maxEntries?: number;
  };
  defaultSessionId?: string;
  defaultThreadId?: string;
  undoClientId?: number;
  createRuntimeDoc?: () => Y.Doc;
  reversalNoticePort?: ReversalNoticePort;
  onInvariantViolation?: (message: string) => void;
  onResponseLifecycleError?: (event: ResponseLifecycleErrorDetail) => void;
  onResponseClaimDiscarded?: (event: ResponseLifecycleClaimDiscardedDetail) => void;
  onResponseCommitterTransition?: (event: ResponseCommitterTransitionDetail) => void;
  onIdempotencyHit?: (event: WriteIdempotencyHitDetail) => void;
  onReversalNoticeFailed?: (event: ReversalNoticeFailedDetail) => void;
  closedResponseTombstoneCap?: number;
  /** Commit-phase seam for deterministic race injection and host observability. */
  afterResponsePreflight?: (responseId: string) => Promise<void> | void;
}
