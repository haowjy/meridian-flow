/**
 * The run-state record: what one chat is doing, as a pure function of its rows, current at a journal
 * position. Every carrier (journal row, stream frame, snapshot, socket state, command answer) holds
 * this one shape, and a client keeps the copy with the greatest `version`.
 */
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
