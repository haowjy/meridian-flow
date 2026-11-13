import type { VirtualItem } from "@tanstack/react-virtual";
import type { FollowMode } from "./useChatFollowScroll";

/**
 * Where a chat's transcript was when the writer left it: the virtualizer's measured row sizes, its
 * scroll offset and whether it was following the tail. The next mount of that chat starts from
 * this, so it paints at the same place without re-measuring from estimates. Module state, per
 * browser tab, like the chat host's other view state; a reload starts every chat fresh.
 */
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
