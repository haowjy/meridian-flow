/** Nullable Work membership resolution for newly created root and child threads. */
import type { WorkRepository } from "../domains/projects/index.js";
import type { ThreadWorksRepository } from "../domains/threads/index.js";

export class InvalidWorkAttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWorkAttachmentError";
  }
}

export interface ResolveWorkMembershipDeps {
  workRepo: WorkRepository;
  threadWorks: ThreadWorksRepository;
}

export interface ResolveWorkMembershipArgs {
  threadId: string;
  projectId: string;
  /** Explicit root assignment. Null and omission both mean no Work. */
  workId?: string | null;
  /** Child threads inherit the parent's real or absent primary membership. */
  parentThreadId?: string | null;
}

export async function resolveWorkMembership(
  deps: ResolveWorkMembershipDeps,
  args: ResolveWorkMembershipArgs,
): Promise<string | null> {
  let primaryWorkId: string | null = null;

  if (args.parentThreadId) {
    primaryWorkId = (await deps.threadWorks.findPrimary(args.parentThreadId))?.workId ?? null;
  } else if (args.workId) {
    const work = await deps.workRepo.findById(args.workId);
    if (
      !work ||
      work.deletedAt ||
      work.status === "archived" ||
      work.projectId !== args.projectId
    ) {
      throw new InvalidWorkAttachmentError("Work is not available in this project");
    }
    primaryWorkId = args.workId;
  }

  if (primaryWorkId) {
    await deps.threadWorks.addMembership(args.threadId, primaryWorkId, true);
  }
  return primaryWorkId;
}
