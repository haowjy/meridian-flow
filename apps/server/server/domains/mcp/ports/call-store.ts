import type { JsonValue } from "@meridian/contracts/threads";

export interface OpenCall {
  threadId: string;
  turnId: string;
  modelResponseId: string;
  toolCallId: string;
  sequence: number;
  connectionId: string;
  pinId: string;
  toolName: string;
  arguments: JsonValue;
}

export interface RecordedCall extends OpenCall {
  id: string;
  outcomeKind: string | null;
  reply: { key: string } | { notKept: string } | null;
  sentAt: Date;
}

export interface CallStore {
  open(call: OpenCall): Promise<string>;
  complete(
    id: string,
    done: { outcomeKind: string; replyRef: JsonValue | null; finishedAt: Date },
  ): Promise<void>;
  listForTurns(threadId: string, turnIds: readonly string[]): Promise<RecordedCall[]>;
}
