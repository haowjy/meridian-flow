// Shared dependencies bag for the write-tool command pipeline modules.
import type * as Y from "yjs";

import type { AgentEditCodec } from "../codec-adapter.js";
import type { ActorSessionStore } from "../ports/actor-session-store.js";
import type { DocumentCoordinator } from "../ports/document-coordinator.js";
import type { DocumentLifecycle } from "../ports/document-lifecycle.js";
import type { AgentEditModel } from "../ports/model.js";
import type { ReversalStore, UpdateJournal } from "../ports/update-journal.js";
import type {
  ResponseCommitterTransitionDetail,
  ResponseLifecycleClaimDiscardedDetail,
  ResponseLifecycleErrorDetail,
  WriteIdempotencyHitDetail,
} from "./types.js";
import type { UndoNotificationFailedDetail, UndoNotificationPort } from "./write-reversal.js";

export interface CreateWriteToolOptions {
  journal: UpdateJournal & ReversalStore;
  coordinator: DocumentCoordinator;
  lifecycle?: DocumentLifecycle;
  codec: AgentEditCodec;
  model: AgentEditModel;
  actorSessionStore?: ActorSessionStore;
  idempotency?: {
    maxEntries?: number;
  };
  defaultSessionId?: string;
  defaultThreadId?: string;
  undoClientId?: number;
  createRuntimeDoc?: () => Y.Doc;
  undoNotificationPort?: UndoNotificationPort;
  onInvariantViolation?: (message: string) => void;
  onBaselineDegraded?: (event: {
    documentId: string;
    responseId: string;
    from: "interaction";
    to: "preOwnSnapshot";
    reason: string;
  }) => void;
  onResponseLifecycleError?: (event: ResponseLifecycleErrorDetail) => void;
  onResponseClaimDiscarded?: (event: ResponseLifecycleClaimDiscardedDetail) => void;
  onResponseCommitterTransition?: (event: ResponseCommitterTransitionDetail) => void;
  onIdempotencyHit?: (event: WriteIdempotencyHitDetail) => void;
  onUndoNotificationFailed?: (event: UndoNotificationFailedDetail) => void;
  closedResponseTombstoneCap?: number;
}
