/** Persistence authority for pending branch-push settlement batches and their recovery. */
import type { DocumentId } from "@meridian/contracts/runtime";
import type { JsonValue } from "@meridian/contracts/threads";
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
import type {
  ApplyItemHold,
  ApplyItemOutcome,
  ApplyMember,
  ApplyRefusal,
} from "./settlement-apply.js";

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

/** What every Apply step plans from, besides the members. */
export type ApplyInputs = {
  /** Durable step inputs staged with the batch, by step kind. */
  payloads: ReadonlyMap<string, JsonValue>;
  /** Each member's full-state fingerprint at its coordinator lease (its lock cut). */
  liveTextFingerprints: ReadonlyMap<DocumentId, string>;
};

export type BatchCompletion = ApplyInputs & {
  batchId: string;
  claim: SettlementClaim;
  members: readonly BatchCompletionMember[];
  /**
   * Synchronous and non-mutating: compares warm state with every admitted
   * member's in-transaction cut after all writes, just before commit. `retry`
   * rolls the whole batch back.
   */
  recheck(cuts: readonly SettlementCut[]): "commit" | "retry";
  /**
   * Runs once the transaction commits, with the members whose text admitted,
   * before every Apply step's after-commit effect.
   */
  afterCommit(admitted: readonly DocumentId[]): void;
};

export type BatchCompletionResult =
  | {
      status: "completed";
      projections: readonly CommittedChangeTrailProjection[];
      /** Every item held for the batch, at the check or in completion, as staged durably. */
      held: readonly ApplyItemHold[];
      /** What the steps did per item, decided under the completion's locks. */
      outcomes: readonly ApplyItemOutcome[];
    }
  /** A step refused: the staged batch is abandoned and its journal rows are reviewable again. */
  | { status: "refused"; reason: ApplyRefusal }
  | { status: "retry" };

/** The pre-staging check: members before any push or batch row exists. */
export type ApplyCheck = ApplyInputs & {
  batchId: string;
  members: readonly ApplyMember[];
};

/** What the check decided, and what to stage. */
export type ApplyCheckResult =
  | {
      kind: "proceed";
      hold: readonly ApplyItemHold[];
      /** The payloads to stage: each step's refined payload where it held items. */
      payloads: ReadonlyMap<string, JsonValue>;
    }
  | { kind: "refuse"; reason: ApplyRefusal };

/** Where a batch's failure was recorded; finite, so the event can carry it. */
export type SettlementFailureStage = "claim" | "execute";

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
  /**
   * Releases the claim with backoff and emits the one visible failure event
   * (warn, then error once the batch is stuck). `error` is the cause, or a
   * reason string when there is none.
   */
  recordFailure(input: {
    batchId: string;
    claim: SettlementClaim;
    stage: SettlementFailureStage;
    error: unknown;
  }): Promise<boolean>;
  block(input: {
    batchId: string;
    claim: SettlementClaim;
    code: string;
    error: string;
  }): Promise<boolean>;
  /**
   * Settles every member in one root-owned transaction: Work locks, Apply
   * steps' namespace locks, document locks, then trail, text admission and
   * Apply steps in the target's order. Nothing reaches a warm room before
   * commit; after it, warm rooms and then each step's after-commit effect run in
   * order. Rejects an ambient transaction before writing, as do staging and
   * recovery claims.
   */
  completeBatch(input: BatchCompletion): Promise<BatchCompletionResult>;
  /**
   * Runs every step's plan and `check()` under the completion's lock order in one
   * short, write-free transaction before staging. Root-owned, like completion.
   */
  checkApply(input: ApplyCheck): Promise<ApplyCheckResult>;
  listRecoverableBatchIds(): Promise<string[]>;
};
