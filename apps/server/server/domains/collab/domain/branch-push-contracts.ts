/** Branch-push (Apply and settlement) contracts shared across collab domain services and adapters. */

import type {
  AgentEditCodecFactory,
  CanonicalBlockIdentity,
  UpdateJournal,
  YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import type { BranchCommandResult } from "@meridian/contracts/branches";
import type { DocumentId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import type { JsonValue } from "@meridian/contracts/threads";
import type * as Y from "yjs";
import type { BranchCommandEnvelope } from "./branch-commands.js";
import type { DraftJournalReadStore, DraftJournalRow } from "./draft-journal.js";
import type { DraftSnapshot, DraftStore } from "./draft-store.js";
import type { ChangeEventDelivery } from "./ports/change-event-delivery.js";
import type { DurableTrailRecord } from "./ports/change-trail-persistence.js";
import type { DocumentLinkScopes } from "./ports/document-link-scope.js";
import type { LiveDocumentCoordinator } from "./ports/live-document-coordinator.js";
import type { PendingSettlementStore } from "./ports/pending-settlement-store.js";
import type { ApplyItemHold, ApplyItemOutcome, ApplyRefusal } from "./ports/settlement-apply.js";
import type { WriterIngressBarrier } from "./ports/writer-ingress-barrier.js";
import type { SweepEvidence } from "./sweep-policy.js";
import type { NormalizedTrail, RawTrailChange, TrailChangeV1 } from "./trail-read-kernel.js";

export class BranchPushCommitConflictError extends Error {
  constructor(readonly draftId: string) {
    super(`Draft ${draftId} changed before its push could commit`);
    this.name = "BranchPushCommitConflictError";
  }
}

export class BranchPushRetryExhaustedError extends Error {
  constructor(
    readonly draftId: string,
    readonly maxRetries: number,
    cause?: unknown,
  ) {
    super(`Draft ${draftId} push did not commit after ${maxRetries} CAS retries`, { cause });
    this.name = "BranchPushRetryExhaustedError";
  }
}

export type ApplyBlockChange = {
  blockId: string;
  beforeBlockIdentity: CanonicalBlockIdentity | null;
  afterBlockIdentity: CanonicalBlockIdentity | null;
  beforeText: string | null;
  afterText: string | null;
};

export type PushLineageRow = {
  id: number;
  draftId: string | null;
  draftGeneration: number;
  documentId: DocumentId;
  journalIds: number[];
  upstreamUpdateSeq: number | null;
  idempotencyKey: string;
  receiptId?: string | null;
  threadId?: ThreadId | null;
  turnId?: TurnId | null;
};

export type PushToLiveResult =
  | {
      status: "pushed";
      push: PushLineageRow;
      update: Uint8Array;
    }
  | { status: "already_pushed"; push: PushLineageRow }
  | {
      status: "noop";
      draftId: string;
      documentId: DocumentId;
      draftGeneration: number;
      reason: "no_active_rows";
    }
  /** An Apply step kept this draft out of live; its rows stay reviewable. */
  | { status: "held"; draftId: string; documentId: DocumentId; reason: ApplyRefusal }
  /** An Apply step refused the whole batch; nothing of it reached live. */
  | { status: "refused"; draftId: string; documentId: DocumentId; reason: ApplyRefusal };

/** Durable Apply-step inputs staged with a batch, by step kind. */
export type ApplyPayloads = Readonly<Record<string, JsonValue>>;

export class DraftChangeRefusal extends Error {
  constructor(readonly status: "stale" | "gone" | "whole_item" | "incomplete_class") {
    super(status);
  }
}

export type PreparedPushCommit = {
  expectedLiveRevision?: string;
  documentDraft: DraftSnapshot;
  journalRows: DraftJournalRow[];
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
  lockCutUpdate: Uint8Array;
  prepared: Omit<
    PreparedPushCommit,
    "pushedByUserId" | "trail" | "receiptId" | "documentTitle" | "lockCutUpdate"
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
  /** Optional evidence for live-session sweep elevation; never settlement authority. */
  sweepEvidence: SweepEvidence | null;
  joinVersion: number;
};

/**
 * Every push one commit staged, settled whole: one claim, one completion
 * transaction, one recovery. A single push is a batch of one.
 */
export type PendingSettlementBatch = {
  batchId: string;
  claim: SettlementClaim;
  attemptCount: number;
  /** Apply-step inputs staged with the batch, by step kind. */
  payloads: ReadonlyMap<string, JsonValue>;
  /** Sorted by document id, the global document lock order. */
  members: readonly PendingLiveSettlement[];
};

export type SweepProjectionDiagnostics = {
  unavailable(input: { pushId: number; documentId: DocumentId; cause: unknown }): void;
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

/** What a per-change Discard left of the item. */
export type DiscardedChanges = { itemClosed: boolean; itemDisposition?: "applied" | "discarded" };

export type ReviewRowSelection = { journalIds: readonly number[]; expectedLiveRevision: string };

/** A per-change Apply's selection: made on each staging attempt's read, naming the payloads it stages. */
export type ChangeApplySelection = {
  draftId: string;
  select(
    documentDraft: DraftSnapshot,
    rows: DraftJournalRow[],
  ): Promise<ReviewRowSelection & { payloads: ApplyPayloads }>;
};

export type PreparedDiscardCommit = {
  /** Present only for per-change Discard: identical survivor deltas in the next generation. */
  survivors?: DraftJournalRow[];
  retireSurvivors?: boolean;
  expectedLiveRevision?: string;
  /** Claimed `done` as the transaction's first write; a taken id throws `BranchCommandExistsError`. */
  command?: { envelope: BranchCommandEnvelope; result: BranchCommandResult };
  documentDraft: DraftSnapshot;
  journalRows: DraftJournalRow[];
  state: Uint8Array;
  reviewedByUserId?: UserId;
};

export type PushCandidate = {
  draftId: string;
  documentId: DocumentId;
  /** The reviewable rows the whole-draft state applies. */
  rows: DraftJournalRow[];
  /** A selected-rows candidate replays only its rows onto live instead of the whole draft. */
  materialization: "whole" | "selected_rows";
};

export type CandidateBatch = {
  /** May be empty when `payloads` carries the whole Apply (one with no text drafts). */
  candidates: PushCandidate[];
  payloads?: ApplyPayloads;
  receiptId: string;
  expectedLiveRevision?: string;
  command?: BranchCommandEnvelope;
  pushedByUserId?: UserId;
};

/** The journal reads plus Apply's push lineage: the reads an Apply makes. */
export type BranchPushReadStore = DraftJournalReadStore & {
  latestPushForDraft(draftId: string, generation: number): Promise<PushLineageRow | null>;
  listPushLineageForTurn(input: { threadId: ThreadId; turnId: TurnId }): Promise<PushLineageRow[]>;
};

export type PushCommitStore = {
  /**
   * Commits every push and stages them under one settlement batch, atomically.
   * A push whose idempotency key already committed reports `conflict` and commits nothing.
   */
  commitPushBatch(input: {
    settlement: SettlementBatchIdentity;
    pushes: readonly PreparedPushCommit[];
    payloads?: ApplyPayloads;
    /** Items the pre-staging check held: staged with the batch as durable exclusions. */
    holds?: readonly ApplyItemHold[];
    /** The writer's command, claimed as the transaction's first write (§4.6). */
    command?: BranchCommandEnvelope;
  }): Promise<
    | { status: "inserted"; pushes: PushLineageRow[] }
    | { status: "conflict"; push: PushLineageRow }
    /** Another request holds the `commandId`: nothing was staged. */
    | { status: "command_exists" }
  >;
  commitDiscard(input: PreparedDiscardCommit): Promise<void>;
};

export type PushUpdateComputer = (input: {
  documentDraft: DraftSnapshot;
  draftDoc: Y.Doc;
  liveDoc: Y.Doc;
}) => Uint8Array;

export type BranchPushService = {
  recoverPendingLiveSettlements(input?: { signal?: AbortSignal }): Promise<number>;
  pushToLive(input: {
    draftId: string;
    pushedByUserId?: UserId;
    signal?: AbortSignal;
  }): Promise<PushToLiveResult>;
  /** Applies several drafts as one batch; one item per requested draft, in request order. */
  pushDraftsToLive(input: {
    /** May be empty when `payloads` carries the whole Apply (one with no text drafts). */
    draftIds: readonly string[];
    payloads?: ApplyPayloads;
    /**
     * Per-change Apply: apply only the rows this selects from the one draft, chosen again on
     * every staging attempt (B3), with the payloads rebuilt from the same selection.
     */
    selected?: ChangeApplySelection;
    /** The writer's command, claimed in the staging transaction (§4.6). */
    command?: BranchCommandEnvelope;
    pushedByUserId?: UserId;
    signal?: AbortSignal;
  }): Promise<{
    items: PushToLiveResult[];
    /** Set when an Apply step refused the batch; every drafted item is `refused`. */
    refused?: ApplyRefusal;
    /** Every item an Apply step held, items without text drafts included. */
    heldItems: readonly ApplyItemHold[];
    /** What the Apply steps did per applied item, decided in completion. */
    outcomes: readonly ApplyItemOutcome[];
    /** Another request holds the command's id: nothing was staged here. */
    commandExists?: true;
  }>;
};

export type DraftReviewService = {
  discardSelected(input: {
    draftId: string;
    selectRows: (
      documentDraft: DraftSnapshot,
      rows: DraftJournalRow[],
    ) => Promise<ReviewRowSelection>;
    reviewedByUserId?: UserId;
    /** The command to claim `done` in the refork's transaction, built from its outcome. */
    command?: {
      envelope: BranchCommandEnvelope;
      result(outcome: DiscardedChanges): BranchCommandResult;
    };
  }): Promise<
    | ({ status: "discarded"; draftId: string; journalIds: number[] } & DiscardedChanges)
    | { status: "nothing_to_undo"; draftId: string; journalIds: number[] }
  >;
};

export type BranchPushServiceInput = {
  draftStore: DraftStore;
  journalReadStore: BranchPushReadStore;
  commitStore: PushCommitStore;
  settlementStore: PendingSettlementStore;
  journal: UpdateJournal;
  liveCoordinator: Pick<LiveDocumentCoordinator, "withDocument" | "recover">;
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodecFactory;
  /** Push and settlement scope themselves; the trail text spells through it. */
  links: DocumentLinkScopes;
  changeEventDelivery: ChangeEventDelivery;
  pushUpdateComputer?: PushUpdateComputer;
  resolveDocumentTitle?: (documentId: DocumentId) => Promise<string | null>;
  writerIngressBarrier?: WriterIngressBarrier;
  sweepProjectionDiagnostics?: SweepProjectionDiagnostics;
  hooks?: { afterDurableCommit?: (documentIds: readonly DocumentId[]) => Promise<void> };
};
