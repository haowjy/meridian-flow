import type { VirtualItem } from "@tanstack/react-virtual";
import type { FollowMode } from "./useChatFollowScroll";

export type ChatViewRecord = {
  measurements: VirtualItem[];
  offset: number;
  mode: FollowMode;
};

const MAX_RECORDS = 32;
const records = new Map<string, ChatViewRecord>();

export function readChatViewRecord(threadId: string): ChatViewRecord | undefined {
  return records.get(threadId);
}

export function writeChatViewRecord(threadId: string, record: ChatViewRecord): void {
  records.delete(threadId);
  records.set(threadId, record);
  if (records.size > MAX_RECORDS) records.delete(records.keys().next().value as string);
}
