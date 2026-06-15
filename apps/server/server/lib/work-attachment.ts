/**
 * Work-attachment resolution: determines which work a new thread belongs to
 * (explicit assignment, inherited parent work, or default). App-layer helper
 * shared by thread creation; depends on the work and thread repositories.
 */
import type { WorkRepository } from "../domains/projects/index.js";
import type { ThreadRepositories } from "./compose.js";

export interface ResolveWorkIdDeps {
  workRepo: WorkRepository;
  threads: ThreadRepositories["threads"];
}

export interface ResolveWorkIdArgs {
  projectId: string;
  /** Explicit work assignment from the request, if any. */
  workId?: string | null;
  /** When set, this is a subagent thread — inherit the parent's work. */
  parentThreadId?: string | null;
  /** Title for the default work when one must be created (e.g. project title). */
  defaultTitle?: string;
}

/**
 * Resolve which work a newly-created thread belongs to.
 *
 * - An explicit `workId` wins.
 * - A subagent inherits its parent thread's work.
 * - A primary thread attaches to the project's default work, creating one if
 *   the project has none yet. This keeps every primary thread grouped under a
 *   real work item until the orchestrator owns work creation during grilling.
 */
export async function resolveWorkIdForThread(
  deps: ResolveWorkIdDeps,
  args: ResolveWorkIdArgs,
): Promise<string | null> {
  if (args.workId) return args.workId;

  if (args.parentThreadId) {
    const parent = await deps.threads.findById(args.parentThreadId);
    return parent?.workId ?? null;
  }

  const work = await deps.workRepo.ensureDefaultForProject(args.projectId, args.defaultTitle);
  return work.id;
}
