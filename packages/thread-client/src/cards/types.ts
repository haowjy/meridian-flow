import type { Failure } from "@meridian/contracts/failures";
import type { Occurrence } from "../commands";

export type ChatCardCopy =
  | "updates-disconnected"
  | "reply-failed"
  | "reply-declined"
  | "compaction-failed"
  | "brief-failed"
  | "retry-refused"
  | "retry-lost"
  | "brief-retry-lost"
  | "brief-stop-failed"
  | "stop-failed"
  | "hand-back-failed"
  | "send-now-failed"
  | "usage-blocked"
  | "send-failed"
  | "compact-enqueue-failed"
  | "switch-draft-failed"
  | "switch-direct-failed"
  | "compact-withdraw-failed"
  | "switch-withdraw-failed";

export type ChatCardAction =
  | "reload"
  | "retry"
  | "retry_brief"
  | "try_again"
  | "add_usage"
  | "dismiss"
  | "edit_or_send"
  | null;

export type ChatCardAnchor =
  | { turn: string }
  | { queuedControl: string }
  | { message: string }
  | "composer";

export type ChatCard = {
  key: string;
  failure: Failure;
  copy: ChatCardCopy;
  action: ChatCardAction;
  anchor: ChatCardAnchor;
  count: number;
  text: string | null;
  requestId: string | null;
};

export type ChatCards = {
  cards: ChatCard[];
  anchoredTurnIds: ReadonlySet<string>;
};

export type RetryRefusal = "another-reply" | "other";

export type RetryOutcome =
  | { kind: "refused"; turnId: string; requestId: string; attempt: number; cause: RetryRefusal }
  | { kind: "lost"; turnId: string; requestId: string; attempt: number };

export type BriefStopFailure = { turnId: string } & Occurrence;
