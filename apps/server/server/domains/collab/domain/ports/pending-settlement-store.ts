/** Persistence authority for pending branch-push settlement batches and their recovery. */
import type { DocumentId } from "@meridian/contracts/runtime";
import type {
  PendingSettlementBatch,
  PushLineageRow,
  SettlementClaim,
  TrailContributionReplacement,
} from "../branch-push-contracts.js";
import type {
  CommittedChangeTrailProjection,
  DurableTrailRecord,
} from "./change-trail-persistence.js";

export type SettlementAdmission = {
  documentId: DocumentId;
  source: { kind: "journal" | "staged_push"; id: string };
  update: Uint8Array;
  excludePushId?: string;
};

/** One member as the caller classified it before the completion transaction. */
export type BatchCompletionMember = {
  push: PushLineageRow;
  /** The join version the caller classified; a moved version retries the batch. */
  joinVersion: number;
  trail: DurableTrailRecord;
  replacement: TrailContributionReplacement;
};

/** A member's settlement cut, read inside the completion transaction. */
export type SettlementCut = {
  pushId: number;
  documentId: DocumentId;
  lockCutUpdate: Uint8Array;
  postCutUpdates: readonly Uint8Array[];
  pushUpdate: Uint8Array;
};

export type BatchCompletion = {
  batchId: string;
  claim: SettlementClaim;
  members: readonly BatchCompletionMember[];
  /**
   * Synchronous and non-mutating: compares warm state with every member's
   * in-transaction cut after all writes, just before commit. `retry` rolls the
   * whole batch back.
   */
  recheck(cuts: readonly SettlementCut[]): "commit" | "retry";
  /** Runs once the transaction commits, before any publication step's after-commit effect. */
  afterCommit(): void;
};

export type BatchCompletionResult =
  | { status: "completed"; projections: readonly CommittedChangeTrailProjection[] }
  | { status: "retry" };

export type PendingSettlementStore = {
  joinAdmission(input: SettlementAdmission): Promise<void>;
  /** Loads a claimed batch outside completion; its cuts are classification input, not authority. */
  loadSettlementBatch(batchId: string): Promise<PendingSettlementBatch>;
  /** Claims an available batch whole; null when another owner holds or finished it. */
  claimRecoverableBatch(input: {
    batchId: string;
    token: string;
  }): Promise<PendingSettlementBatch | null>;
  renewClaim(input: { batchId: string; claim: SettlementClaim }): Promise<SettlementClaim | null>;
  recordFailure(input: {
    batchId: string;
    claim: SettlementClaim;
    error: string;
  }): Promise<boolean>;
  block(input: {
    batchId: string;
    claim: SettlementClaim;
    code: string;
    error: string;
  }): Promise<boolean>;
  /**
   * Settles every member in one transaction: Work locks, publication steps'
   * namespace locks, document locks, then trail, text admission and
   * publication steps in the target's order. Nothing reaches a warm room
   * before commit.
   */
  completeBatch(input: BatchCompletion): Promise<BatchCompletionResult>;
  listRecoverableBatchIds(): Promise<string[]>;
};
