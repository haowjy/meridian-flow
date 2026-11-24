import { type Work, workLifecycleState } from "@meridian/contracts/works";
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
  workId?: string | null;
  parentThreadId?: string | null;
}

export async function resolveRootWork(
  deps: Pick<ResolveWorkMembershipDeps, "workRepo">,
  args: { projectId: string; workId?: string | null },
): Promise<Work> {
  if (args.workId) {
    const work = await deps.workRepo.findById(args.workId);
    if (!work || workLifecycleState(work) !== "active" || work.projectId !== args.projectId) {
      throw new InvalidWorkAttachmentError("Work is not available in this project");
    }
    return work;
  }
  const noWork = await deps.workRepo.findNoWork(args.projectId);
  if (!noWork) throw new InvalidWorkAttachmentError("No Work is missing for this project");
  return noWork;
}

export async function resolveWorkMembership(
  deps: ResolveWorkMembershipDeps,
  args: ResolveWorkMembershipArgs,
): Promise<string> {
  const inherited = args.parentThreadId
    ? ((await deps.threadWorks.findPrimary(args.parentThreadId))?.workId ?? null)
    : null;
  const workId = args.parentThreadId ? null : args.workId;
  const primaryWorkId =
    inherited ?? (await resolveRootWork(deps, { projectId: args.projectId, workId })).id;

  await deps.threadWorks.addMembership(args.threadId, primaryWorkId, true);
  return primaryWorkId;
}
