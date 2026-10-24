/**
 * The card vocabulary: what a chat failure card is, before any word is chosen for it. A card names
 * its occurrence (`key`), its `Failure`, a closed copy key, the one action it offers and the thing
 * it sits on. The app draws it where it is anchored and words it from the copy key.
 */

import type { Failure } from "@meridian/contracts/failures";
import type { Occurrence } from "../commands";

/** The closed set of cards. The app owns the words; a reply's own words ride in `text`. */
export type ChatCardCopy =
  /** "This response failed." */
  | "reply-failed"
  /** "The AI provider turned this request down." */
  | "reply-declined"
  /** The server's `turn.error` for a manual compaction (`text`); the app words a missing one. */
  | "compaction-failed"
  /** The server's `turn.error` for the handoff brief (`text`). */
  | "brief-failed"
  /** "Couldn't retry." */
  | "retry-refused"
  /** "Couldn't retry. Another reply started first." */
  | "retry-refused-another-reply"
  /** "Couldn't start the retry." */
  | "retry-lost"
  /** "Couldn't start a new brief." */
  | "brief-retry-lost"
  /** "Couldn't stop the brief." */
  | "brief-stop-failed"
  /** "Couldn't stop the reply." */
  | "stop-failed"
  /** "Couldn't move your queued message to the message box." (plural with `count`) */
  | "hand-back-failed"
  /** "Couldn't move your queued message." (plural with `count`) */
  | "hand-back-refused"
  /** "Couldn't send now." */
  | "send-now-failed"
  /** "You're out of usage. Your messages will send when you add more." */
  | "usage-blocked"
  /** "Couldn't send." on a writer message */
  | "send-failed"
  /** "Couldn't queue the compaction." */
  | "compact-enqueue-failed"
  /** "Couldn't switch to draft mode." */
  | "switch-draft-failed"
  /** "Couldn't switch to auto-apply." */
  | "switch-direct-failed"
  /** "Couldn't stop the compaction." */
  | "compact-withdraw-failed"
  /** "Couldn't stop the switch." */
  | "switch-withdraw-failed";

export type ChatCardAction =
  | "retry"
  | "retry_brief"
  | "try_again"
  | "add_usage"
  | "dismiss"
  | "edit_or_send"
  | null;

/** Where a card is drawn: on a turn, on a queued command's row, under a writer message, or in the composer's stack. */
export type ChatCardAnchor =
  | { turn: string }
  | { queuedControl: string }
  | { message: string }
  | "composer";

export type ChatCard = {
  /** The failure's occurrence id: `${requestId}:${attempt}` for a command, the turn id for a reply, `usage:${threadId}:${seq}` for usage. */
  key: string;
  failure: Failure;
  copy: ChatCardCopy;
  action: ChatCardAction;
  anchor: ChatCardAnchor;
  /** How many messages a hand-back card covers (plural copy); 1 elsewhere. */
  count: number;
  /** The server's words for a reply card that shows them; null otherwise. */
  text: string | null;
  /** The command a hand-back card replays or dismisses; null for every other card. */
  requestId: string | null;
};

export type ChatCards = {
  cards: ChatCard[];
  /** Turns a card is anchored on: `viewTranscript` keeps their rows. */
  anchoredTurnIds: ReadonlySet<string>;
};

/** Why the server refused a Retry, when it said: another reply took the chat first (409), or no cause worth naming. */
export type RetryRefusal = "another-reply" | "other";

/** A Retry that did not start a reply. `turnId` is the failed reply (or brief) it was pressed on. */
export type RetryOutcome =
  | { kind: "refused"; turnId: string; requestId: string; attempt: number; cause: RetryRefusal }
  | { kind: "lost"; turnId: string; requestId: string; attempt: number };

/** A Stop on a handoff brief that did not reach the server, by attempt. */
export type BriefStopFailure = { turnId: string } & Occurrence;
