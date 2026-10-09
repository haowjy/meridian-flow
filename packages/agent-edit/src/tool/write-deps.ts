// Shared dependencies bag for the write-tool command pipeline modules.
import type * as Y from "yjs";

import type { AgentEditCodecFactory } from "../codec-adapter.js";
import type { SpliceFallback } from "../links/find-splice.js";
import type { ActorSessionStore } from "../ports/actor-session-store.js";
import type { DocumentCoordinator } from "../ports/document-coordinator.js";
import type { DocumentLifecycle } from "../ports/document-lifecycle.js";
import type { DocumentLinksPort } from "../ports/document-links.js";
import type { AgentEditModel } from "../ports/model.js";
import type { SemanticProvenanceWriter } from "../ports/semantic-provenance.js";
import type { ReversalStore, UpdateJournal } from "../ports/update-journal.js";
import type {
  ResponseCommitterTransitionDetail,
  ResponseLifecycleClaimDiscardedDetail,
  ResponseLifecycleErrorDetail,
  UnexpectedWriteErrorDetail,
  WriteIdempotencyHitDetail,
} from "./types.js";
import type { ReversalNoticeFailedDetail, ReversalNoticePort } from "./write-reversal.js";

export interface LinkSpliceFallbackDetail {
  documentId: string;
  reason: SpliceFallback;
}

export interface CreateWriteToolOptions {
  journal: UpdateJournal & ReversalStore;
  coordinator: DocumentCoordinator;
  lifecycle?: DocumentLifecycle;
  /** Parses purely; each command binds it to its prepared holder scope. */
  codec: AgentEditCodecFactory;
  /** The host's link scope: prepare, holder scope, ahead registration and view revision. */
  links: DocumentLinksPort;
  model: AgentEditModel;
  /** Durable lookup authority for the response that authored a mutation. */
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
  /**
   * A formatted find could not tell the links outside its splice apart and
   * bound the whole block group instead: identity still follows
   * correspondence, but unchanged links there may churn their formatting.
   */
  onLinkSpliceFallback?: (event: LinkSpliceFallbackDetail) => void;
  onResponseLifecycleError?: (event: ResponseLifecycleErrorDetail) => void;
  onResponseClaimDiscarded?: (event: ResponseLifecycleClaimDiscardedDetail) => void;
  onResponseCommitterTransition?: (event: ResponseCommitterTransitionDetail) => void;
  onIdempotencyHit?: (event: WriteIdempotencyHitDetail) => void;
  onUnexpectedWriteError?: (event: UnexpectedWriteErrorDetail) => void;
  onReversalNoticeFailed?: (event: ReversalNoticeFailedDetail) => void;
  /** Stage live reversal projection until the host transaction commits. */
  deferUntilCommit?(callback: () => void | Promise<void>): boolean;
  closedResponseTombstoneCap?: number;
  /** Commit-phase seam for deterministic race injection and host observability. */
  afterResponsePreflight?: (responseId: string) => Promise<void> | void;
}
