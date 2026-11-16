/** Persistence for the record of each connection call (`mcp_calls`). */
import type { JsonValue } from "@meridian/contracts/threads";

export interface OpenCall {
  threadId: string;
  turnId: string;
  modelResponseId: string;
  toolCallId: string;
  /** The call's place under its tool call: 0 for `mcp_call`, a script's call number for `mcp_run`. */
  sequence: number;
  connectionId: string;
  pinId: string;
  toolName: string;
  /** As sent. */
  arguments: JsonValue;
}

export interface RecordedCall extends OpenCall {
  id: string;
  /** Null while the call is open: its end is unknown. */
  outcomeKind: string | null;
  /** The reply was stored beside the chat (the record's `replyRef` has a key). */
  replyKept: boolean;
  sentAt: Date;
}

export interface CallStore {
  /** Writes the row in a transaction of its own, so it exists before the call leaves. */
  open(call: OpenCall): Promise<string>;
  complete(
    id: string,
    done: { outcomeKind: string; replyRef: JsonValue | null; finishedAt: Date },
  ): Promise<void>;
  /** The recorded calls of these turns of a thread, for the unfinished-call stub. */
  listForTurns(threadId: string, turnIds: readonly string[]): Promise<RecordedCall[]>;
}
