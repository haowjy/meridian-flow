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
  /** Runs once the transaction commits, before every publication step's after-commit effect. */
  afterCommit(): void;
};

export type BatchCompletionResult =
  | { status: "completed"; projections: readonly CommittedChangeTrailProjection[] }
  | { status: "retry" };

export type PendingSettlementStore = {
  joinAdmission(input: SettlementAdmission): Promise<void>;
  /**
   * Loads a batch while `owner` still holds it, outside completion; its cuts are
   * classification input, not authority. Null once another claimant, or the same
   * token at a later epoch, owns it: ownership is never adopted from the row.
   */
  loadSettlementBatch(input: {
    batchId: string;
    owner: Pick<SettlementClaim, "token" | "epoch">;
  }): Promise<PendingSettlementBatch | null>;
  /**
   * Claims an available batch whole with the credentials its claim UPDATE returned;
   * null when another owner holds, finished or took it over before the read.
   */
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
   * Settles every member in one root-owned transaction: Work locks, publication
   * steps' namespace locks, document locks, then trail, text admission and
   * publication steps in the target's order. Nothing reaches a warm room before
   * commit; after it, warm rooms and then each step's after-commit effect run in
   * order. Rejects an ambient transaction before writing, as do staging and
   * recovery claims.
   */
  completeBatch(input: BatchCompletion): Promise<BatchCompletionResult>;
  listRecoverableBatchIds(): Promise<string[]>;
};
