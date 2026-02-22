import type { Proposal } from "../proposals/contracts";

export type ProposalReviewUnavailableReason =
  | "missing_update"
  | "invalid_update"
  | "update_apply_failed";

interface ProposalReviewBase {
  proposal: Proposal;
  baseText: string;
}

export interface ProposalReviewUnavailable extends ProposalReviewBase {
  availability: "unavailable";
  reason: ProposalReviewUnavailableReason;
  message: string;
}
