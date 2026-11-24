import type { Database } from "@meridian/database";
import { createDrizzleInbox } from "../domains/runtime/adapters/drizzle-inbox.js";
import { createDrizzleThreadLock } from "../domains/runtime/adapters/drizzle-thread-lock.js";
import { createQuietDrizzleJournalWriter } from "./journal-writer.js";

export function createLockedDrizzleInbox(db: Database) {
  const inbox = createDrizzleInbox(db);
  const lock = createDrizzleThreadLock(db, createQuietDrizzleJournalWriter(db));
  return {
    ...inbox,
    enqueue: (draft: Parameters<typeof inbox.enqueue>[0]) =>
      lock.withThreadLock(draft.threadId, () => inbox.enqueue(draft)),
    ack: (...args: Parameters<typeof inbox.ack>) =>
      lock.withThreadLock(args[0], () => inbox.ack(...args)),
    setBlockedReason: (...args: Parameters<typeof inbox.setBlockedReason>) =>
      lock.withThreadLock(args[0], () => inbox.setBlockedReason(...args)),
  };
}
