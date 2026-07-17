/**
 * Work membership resolution for newly-created threads. Creates the thread_works
 * primary membership after the thread row exists, so Work context scoping has one
 * source of truth and no stale threads.work_id column path.
 */
import type { Project } from "@meridian/contracts/projects";
import type { UserId } from "@meridian/contracts/runtime";
import { resolveDefaultWork, type WorkRepository } from "../domains/projects/index.js";
import type { ThreadWorksRepository } from "../domains/threads/index.js";

export class InvalidWorkAttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWorkAttachmentError";
  }
}

export class MissingPrimaryWorkMembershipError extends Error {
  constructor(public readonly parentThreadId: string) {
    super(
      `Cannot spawn subagent: parent thread "${parentThreadId}" has no primary Work membership`,
    );
    this.name = "MissingPrimaryWorkMembershipError";
  }
}

export interface ResolveWorkMembershipDeps {
  workRepo: WorkRepository;
  threadWorks: ThreadWorksRepository;
}

export interface ResolveWorkMembershipArgs {
  threadId: string;
  projectId: string;
  /** Required only when selecting the default Work for a primary thread. */
  project?: Project;
  /** Required only when selecting the default Work for a primary thread. */
  userId?: UserId;
  /** Explicit work assignment from the request, if any. */
  workId?: string | null;
  /** When set, this is a subagent thread — inherit the parent's primary Work. */
  parentThreadId?: string | null;
}

/**
 * Create thread-to-Work membership(s) for a newly-created thread.
 *
 * - An explicit `workId` wins: creates one membership (isPrimary = true).
 * - A subagent inherits its parent's primary Work as its own primary.
 * - A primary thread with no explicit work: attaches to the project's default work.
 *
 * Returns the primary Work ID.
 */
export async function resolveWorkMembership(
  deps: ResolveWorkMembershipDeps,
  args: ResolveWorkMembershipArgs,
): Promise<string> {
  let primaryWorkId: string;

  if (args.workId) {
    const work = await deps.workRepo.findById(args.workId);
    if (!work || work.deletedAt || work.projectId !== args.projectId) {
      throw new InvalidWorkAttachmentError("Work is not available in this project");
    }
    primaryWorkId = args.workId;
  } else if (args.parentThreadId) {
    const parentPrimary = await deps.threadWorks.findPrimary(args.parentThreadId);
    if (!parentPrimary) {
      throw new MissingPrimaryWorkMembershipError(args.parentThreadId);
    }
    primaryWorkId = parentPrimary.workId;
  } else {
    if (!args.project || !args.userId) {
      throw new Error("Project and user are required to resolve a primary thread's default Work");
    }
    primaryWorkId = await resolveDefaultWork(
      { works: deps.workRepo },
      { userId: args.userId },
      args.project,
    );
  }

  await deps.threadWorks.addMembership(args.threadId, primaryWorkId, true);
  return primaryWorkId;
}
