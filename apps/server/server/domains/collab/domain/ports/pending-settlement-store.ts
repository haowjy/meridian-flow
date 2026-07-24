/** Persistence authority for pending branch-push settlement and recovery. */
import type { DocumentId } from "@meridian/contracts/runtime";
import type {
  CompletionFenceResult,
  PendingLiveSettlement,
  PushLineageRow,
  SettlementClaim,
  TrailContributionReplacement,
} from "../branch-push-contracts.js";
import type { DurableTrailRecord } from "./change-trail-persistence.js";

export type SettlementAdmission = {
  documentId: DocumentId;
  source: { kind: "journal" | "staged_push"; id: string };
  update: Uint8Array;
  excludePushId?: string;
};

export type PendingSettlementStore = {
  joinAdmission(input: SettlementAdmission): Promise<void>;
  loadLiveSettlement(pushId: number): Promise<PendingLiveSettlement>;
  claimRecoverable(input: { pushId: number; token: string }): Promise<PendingLiveSettlement | null>;
  renewClaim(input: { pushId: number; claim: SettlementClaim }): Promise<SettlementClaim | null>;
  handoffClaim(input: { pushId: number; claim: SettlementClaim }): Promise<boolean>;
  recordFailure(input: { pushId: number; claim: SettlementClaim; error: string }): Promise<boolean>;
  block(input: {
    pushId: number;
    claim: SettlementClaim;
    code: string;
    error: string;
  }): Promise<boolean>;
  settlePushTrail(input: {
    push: PushLineageRow;
    trail?: DurableTrailRecord;
    replacement?: TrailContributionReplacement;
    claim: SettlementClaim;
    joinVersion: number;
  }): Promise<boolean>;
  withCompletionFence(
    input: {
      pushId: number;
      documentId: DocumentId;
      claim: SettlementClaim;
      settledJoinVersion: number;
    },
    complete: () => CompletionFenceResult,
  ): Promise<CompletionFenceResult>;
  listRecoverableSettlementIds(): Promise<number[]>;
};
