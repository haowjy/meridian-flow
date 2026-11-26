import type { ThreadId } from "@meridian/contracts/runtime";

export interface DocumentRevisions {
  current(input: {
    threadId: ThreadId;
    documentIds: readonly string[];
  }): Promise<Map<string, string | null>>;
}
