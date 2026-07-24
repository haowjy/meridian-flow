/**
 * Thread authorization helper: requireThreadOwner loads a thread and asserts the
 * caller owns it and its parent project is live, throwing 404 otherwise. Owns
 * the thread ownership gate; depends inward on the thread/project repositories.
 */

import type { Project } from "@meridian/contracts/projects";
import type { UserId } from "@meridian/contracts/runtime";
import type { Thread } from "@meridian/contracts/threads";
import { throwHttpInterruptForStatus } from "../../lib/interrupt-boundary.js";
import { parseRequestId } from "../../lib/uuid.js";
import type { ThreadRepository } from "./index.js";

interface ProjectOwnerRepository {
  findById(id: string): Promise<Project | null>;
}

/** Owner gate: 404 for missing, wrong user, deleted thread, or soft-deleted parent project. */
export async function requireThreadOwner(
  repos: { threads: Pick<ThreadRepository, "findById">; projects: ProjectOwnerRepository },
  threadId: string,
  userId: UserId,
): Promise<Thread> {
  const parsedThreadId = parseRequestId(threadId);
  if (!parsedThreadId) {
    throwHttpInterruptForStatus(400, "`threadId` must be a canonical UUID");
  }
  const thread = await repos.threads.findById(parsedThreadId);
  if (!thread || thread.deletedAt) {
    throwHttpInterruptForStatus(404, "Thread not found");
  }
  const project = await repos.projects.findById(thread.projectId);
  if (!project || project.deletedAt || project.userId !== userId) {
    throwHttpInterruptForStatus(404, "Thread not found");
  }
  if (thread.userId !== userId) {
    throwHttpInterruptForStatus(404, "Thread not found");
  }
  return thread;
}
