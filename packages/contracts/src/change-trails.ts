/** Shared wire contract for durable change-trail forward actions. */

export type TrailForwardAction = "restore" | "delete-again";

export type TrailForwardActionStateV1 =
  | {
      status: "committed";
      update: string;
      expectedLiveStateHash: string;
    }
  | { status: "applied"; updateId: number }
  | {
      status: "settled";
      outcome: "anchor_unavailable" | "retry_exhausted";
    };

export type TrailForwardActionResult =
  | { status: "applied" | "already_applied" }
  | { status: "anchor_unavailable" }
  | { status: "retry_exhausted" };
