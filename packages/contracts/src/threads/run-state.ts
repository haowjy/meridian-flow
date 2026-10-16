/**
 * The run-state record: what one chat is doing, as a pure function of its rows, current at a journal
 * position. Every carrier (journal row, stream frame, snapshot, socket state, command answer) holds
 * this one shape, and a client keeps the copy with the greatest `version`.
 */

import type { UserMessageBlock } from "../protocol/user-turn-admission.js";
import type { AiWriteMode } from "../works/index.js";
import type { PendingInboxItem } from "./index.js";

export type RunState = {
  /**
   * Event-seq cursor (decimal string), compared with `compareSeq`. Stream: the record event's own seq.
   * Snapshot, socket state and answers: the journal head read with the record.
   */
  version: string;
  /** The chat's unacknowledged inbox in seq order (Work-context notices excluded). A queued switch is a control row. */
  items: PendingInboxItem[];
  /** Highest inbox seq among the chat's writer messages, delivered ones included; 0 when none. */
  sentThrough: number;
  /** The open execution, once a turn carries its id. Null otherwise. */
  execution: { executionId: string; currentTurnId: string | null } | null;
  /** The chat's applied write mode (`threads.ai_write_mode`). */
  mode: AiWriteMode;
  /** Why the waiting work can't start, or null. */
  blocked: { reason: "credits_exhausted" } | null;
};

/**
 * Hand back these waiting writer messages, by user turn id. The queue's x sends one id; Cancel queue sends every
 * id the client drew as queued, frozen at the press. Never cancels a reply.
 */
export type HandBackRequest = { requestId: string; ids: string[] };

/** One request's outcome for every message it names, decided once under the thread lock and stored. A replay returns it unchanged. */
export type HandBackResult = {
  /** Handed back by this request, in send order, with their content. The acting tab's composer receives these. */
  handedBack: { userTurnId: string; blocks: UserMessageBlock[] }[];
  /** Taken on before this request by an execution that goes on: they stay and are answered. */
  answered: string[];
  /** Already handed back by another request (another tab, or an earlier x): their content went there. */
  gone: string[];
};

export type HandBackResponse = HandBackResult & { runState: RunState };

export type StopRequest = {
  requestId: string;
  seenThrough: number;
  seenExecutionId: string | null;
  mine: string[];
};

export type StopResponse = HandBackResult & {
  threadId: string;
  /** The execution this press cancelled, or null. */
  cancelledExecutionId: string | null;
  /** The record after this press, from `answerRunState`. */
  runState: RunState;
};

/**
 * Send now: cancel the reply the writer saw so the waiting queue runs next. `waiting` is every writer message the
 * record showed waiting. No request id: `seenExecutionId` makes a repeat of the same body safe.
 */
export type SendNowRequest = {
  seenThrough: number;
  seenExecutionId: string;
  waiting: string[];
};

export type SendNowResponse = {
  threadId: string;
  /** The execution this attempt cancelled, or null: this attempt requested no cancellation. */
  cancelledExecutionId: string | null;
  /** The record after this attempt, from `answerRunState`. */
  runState: RunState;
};
