/** Neutral branch-push contracts shared across collab domain services and adapters. */

import type {
  AgentEditCodecFactory,
  CanonicalBlockIdentity,
  DocumentCoordinator,
  YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import type { DraftDecidedOutcome, DraftOverride } from "@meridian/contracts/drafts";
import type { DocumentId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import type { JsonValue } from "@meridian/contracts/threads";
import type { BranchCoordinator, BranchSnapshot, BranchStore } from "./branch-coordinator.js";
import type { BranchCriticalSections } from "./branch-critical-sections.js";
import type { ContentApplyRequest, ContentMemberInput } from "./draft-apply.js";
import type { DraftCommandEnvelope } from "./draft-commands.js";
import type { DraftRebase } from "./draft-rebase.js";
import type { ChangeEventDelivery } from "./ports/change-event-delivery.js";
import type { DurableTrailRecord } from "./ports/change-trail-persistence.js";
import type { DocumentLinkScopes } from "./ports/document-link-scope.js";
import type { PendingSettlementStore } from "./ports/pending-settlement-store.js";
import type {
  BaseWrite,
  PublicationItemHold,
  PublicationRefusal,
} from "./ports/settlement-publication.js";
import type { WriterIngressBarrier } from "./ports/writer-ingress-barrier.js";
import type { NormalizedTrail, RawTrailChange, TrailChangeV1 } from "./trail-read-kernel.js";

export class BranchPushCommitConflictError extends Error {
  constructor(readonly branchId: string) {
    super(`Branch ${branchId} changed before its push could commit`);
    this.name = "BranchPushCommitConflictError";
  }
}

export class BranchPushRetryExhaustedError extends Error {
  constructor(
    readonly branchId: string,
    readonly maxRetries: number,
    cause?: unknown,
  ) {
    super(`Branch ${branchId} push did not commit after ${maxRetries} CAS retries`, { cause });
    this.name = "BranchPushRetryExhaustedError";
  }
}

export type BranchJournalRow = {
  id: number;
  branchId: string;
  wId: number | null;
  /** The model's tool call that made this write; null for writer rows and legacy rows. */
  toolCallId?: string | null;
  source: "agent" | "writer";
  threadId: ThreadId | null;
  turnId: TurnId | null;
  actorUserId: UserId | null;
  updateData: Uint8Array;
  /** Immutable live-journal watermark captured with this draft mutation. */
  draftBaseUpdateSeq: number;
  status: "active" | "pushed" | "discarded" | "rollback_pending";
  updateMeta?: unknown;
  /** Immutable edit evidence, never inferred from actor or missing text. */
  editKind?: "write" | "undo" | "redo" | "revert" | "rollback";
};

export type PublicationBlockChange = {
  blockId: string;
  beforeBlockIdentity: CanonicalBlockIdentity | null;
  afterBlockIdentity: CanonicalBlockIdentity | null;
  beforeText: string | null;
  afterText: string | null;
};

export type PushLineageRow = {
  id: number;
  branchId: string | null;
  documentId: DocumentId;
  journalIds: number[];
  upstreamUpdateSeq: number | null;
  idempotencyKey: string;
  receiptId?: string | null;
  threadId?: ThreadId | null;
  turnId?: TurnId | null;
  /** The content member's frozen input (`apply_payload`); null on a row older than content Apply. */
  input?: ContentMemberInput | null;
};

/** Durable publication-step inputs staged with a batch, by step kind. */
export type PublicationPayloads = Readonly<Record<string, JsonValue>>;

/**
 * One content member staged: the text branch's merge into live. `input` is frozen at staging, so
 * recovery after a crash never applies draft words written after it (contract §1.1).
 */
export type PreparedPushCommit = {
  branch: BranchSnapshot;
  input: ContentMemberInput;
  pushUpdate: Uint8Array;
  idempotencyKey: string;
  receiptId?: string;
  pushedByUserId?: UserId;
  /** Required participant in the atomic branch-push commit bundle. */
  trail: DurableTrailRecord;
  documentTitle: string;
  /** The live state captured as the document lock was taken (the LOCK-WS cut). */
  lockCutUpdate: Uint8Array;
};

export type PreparedPush = {
  trailChanges: RawTrailChange[];
  /** The draft rows whose chats own the trail: a content Apply pushes none, so the pending rows name them. */
  attributionRows: BranchJournalRow[];
  lockCutUpdate: Uint8Array;
  prepared: Omit<
    PreparedPushCommit,
    "pushedByUserId" | "trail" | "receiptId" | "documentTitle" | "lockCutUpdate" | "input"
  > & { receiptId: string };
};

/** The durable identity a batch of staged pushes settles under, minted before its commit. */
export type SettlementBatchIdentity = { batchId: string; claimToken: string };

/** The committer's warm claim is the batch's first epoch; every later claim increments it. */
export const FIRST_CLAIM_EPOCH = 1;

/** One staged push of a settlement batch, as completion and recovery load it. */
export type PendingLiveSettlement = {
  push: PushLineageRow;
  documentTitle: string;
  lockCutUpdate: Uint8Array;
  pushUpdate: Uint8Array;
  postCutUpdates: readonly Uint8Array[];
  trail: DurableTrailRecord;
  joinVersion: number;
};

/**
 * What settlement's replan decided for one member, carried into completion and the after-commit room
 * apply (contract §2.1). `base` is the text branch's base patch, computed under the branch lease.
 */
export type ReplannedMember = {
  pushId: number;
  outcome:
    | {
        status: "applied";
        pushUpdate: Uint8Array;
        trail: DurableTrailRecord;
        overrode: DraftOverride[];
      }
    /** Live already reads the merge: withdrawn like a held member, nothing written to live. */
    | { status: "already_live" };
  base: BaseWrite;
};

/**
 * Every push one commit staged, settled whole: one claim, one completion
 * transaction, one recovery. A single push is a batch of one.
 */
export type PendingSettlementBatch = {
  batchId: string;
  claim: SettlementClaim;
  attemptCount: number;
  /** Publication-step inputs staged with the batch, by step kind. */
  payloads: ReadonlyMap<string, JsonValue>;
  /** Sorted by document id, the global document lock order. */
  members: readonly PendingLiveSettlement[];
};

export type SettlementClaim = {
  token: string;
  epoch: number;
  kind: "warm" | "recovery";
  leaseExpiresAt: Date;
};

type TrailContributionTarget = {
  owner: NormalizedTrail["owner"];
  changes: readonly TrailChangeV1[];
};

export type TrailContributionReplacement = {
  targets: readonly TrailContributionTarget[];
  documentTitles: ReadonlyMap<string, string>;
};

export type BranchJournalReadStore = {
  listReviewableJournalRows(branchId: string): Promise<BranchJournalRow[]>;
  listConcurrentJournalRows(
    branchId: string,
    options: { afterJournalId?: number; documentId: DocumentId },
  ): Promise<BranchJournalRow[]>;
  listJournalRowsForBranch(input: {
    branchId: string;
    throughJournalId?: number;
  }): Promise<BranchJournalRow[]>;
};

export type PushCommitStore = {
  /**
   * Commits every content member and stages them under one settlement batch, atomically.
   * A push whose idempotency key already committed reports `conflict` and commits nothing.
   */
  commitPushBatch(input: {
    settlement: SettlementBatchIdentity;
    pushes: readonly PreparedPushCommit[];
    payloads?: PublicationPayloads;
    /** Items the pre-staging check held: staged with the batch as durable exclusions. */
    holds?: readonly PublicationItemHold[];
    /** The writer's command, claimed as the transaction's first write (§1.4). */
    command: DraftCommandEnvelope;
  }): Promise<
    | { status: "inserted"; pushes: PushLineageRow[] }
    | { status: "conflict"; push: PushLineageRow }
    /** Another request holds the `commandId`: nothing was staged. */
    | { status: "command_exists" }
  >;
};

/** One text branch an Apply publishes, with what the writer asked of it. */
export type ContentPublicationRequest = {
  branchId: string;
  itemKey: string;
  request: ContentApplyRequest;
};

export type BranchPushService = {
  recoverPendingLiveSettlements(input?: { signal?: AbortSignal }): Promise<number>;
  /**
   * Settles every pending batch with a member on these documents, then answers whether any
   * pending or blocked batch is left on them (contract §2.2 step 1).
   */
  settleUnfinished(
    documentIds: readonly DocumentId[],
    signal?: AbortSignal,
  ): Promise<{ unfinished: boolean }>;
  /**
   * Publishes an Apply as one batch: each requested text branch as a content member (a merge into
   * live, planned under its lease and the live lock), with the publication steps' payloads. Items
   * whose content planning decided `already_live`, `not_found` or `failed` stage no member and
   * go to `finalizePayloads`, which returns the payloads actually staged (the tree part of a
   * failed item is excluded). The command's terminal result is stored by the tree step in the
   * batch's completion; a batch with no member still stages the tree payload that carries it.
   */
  pushBranchesToLive(input: {
    members: readonly ContentPublicationRequest[];
    /** The payloads as planned before content decisions: they name the branches to lease. */
    payloads: PublicationPayloads;
    finalizePayloads(decided: readonly DraftDecidedOutcome[]): PublicationPayloads;
    /** The writer's command, claimed in the staging transaction (§1.4). */
    command: DraftCommandEnvelope;
    pushedByUserId?: UserId;
    signal?: AbortSignal;
  }): Promise<{
    /** Set when a publication step refused the batch. */
    refused?: PublicationRefusal;
    /** Another request holds the command's id: nothing was staged here. */
    commandExists?: true;
  }>;
};

export type BranchPushServiceInput = {
  branchStore: BranchStore;
  journalReadStore: BranchJournalReadStore;
  commitStore: PushCommitStore;
  settlementStore: PendingSettlementStore;
  /** The catch-up rebase Apply runs first, under the leases it owns (contract §2.2 step 2.3). */
  draftRebase: DraftRebase;
  branchCoordinator?: Partial<Pick<BranchCoordinator, "broadcastUpdate">>;
  liveCoordinator: DocumentCoordinator;
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodecFactory;
  /** Push and settlement scope themselves; the trail text spells through it. */
  links: DocumentLinkScopes;
  changeEventDelivery: ChangeEventDelivery;
  criticalSections?: BranchCriticalSections;
  resolveDocumentTitle?: (documentId: DocumentId) => Promise<string | null>;
  writerIngressBarrier?: WriterIngressBarrier;
  /** Reports a content plan that threw, once (the rebase emitter, contract §5.5). */
  mergeFailed?(input: { branchId: string; documentId: DocumentId }): void;
  hooks?: { afterDurableCommit?: (documentIds: readonly DocumentId[]) => Promise<void> };
};
