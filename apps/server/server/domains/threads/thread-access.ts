// @ts-nocheck
/**
 * Thread authorization helper: requireThreadOwner loads a thread and asserts the
 * caller owns it and its parent workbench is live, throwing 404 otherwise. Owns
 * the thread ownership gate; depends inward on the thread/workbench repositories.
 */

import type { UserId } from "@meridian/contracts/runtime";
import type { Thread } from "@meridian/contracts/threads";
import type { Workbench } from "@meridian/contracts/workbenches";
import { throwHttpInterruptForStatus } from "../../lib/interrupt-boundary.js";
import type { ThreadRepository } from "./index.js";

interface WorkbenchOwnerRepository {
  findById(id: string): Promise<Workbench | null>;
}

/** Owner gate: 404 for missing, wrong user, deleted thread, or soft-deleted parent workbench. */
export async function requireThreadOwner(
  repos: { threads: ThreadRepository; workbenches: WorkbenchOwnerRepository },
  threadId: string,
  userId: UserId,
): Promise<Thread> {
  const thread = await repos.threads.findById(threadId);
  if (!thread || thread.deletedAt) {
    throwHttpInterruptForStatus(404, "Thread not found");
  }
  const workbench = await repos.workbenches.findById(thread.workbenchId);
  if (!workbench || workbench.deletedAt || workbench.userId !== userId) {
    throwHttpInterruptForStatus(404, "Thread not found");
  }
  if (thread.userId !== userId) {
    throwHttpInterruptForStatus(404, "Thread not found");
  }
  return thread;
}
