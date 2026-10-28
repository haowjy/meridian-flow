/** Soft-delete and restore commands for a Work-owned tree. */
import type { ThreadId, WorkId } from "@meridian/contracts/runtime";
import type { Work } from "@meridian/contracts/works";
import type { WorkRepository } from "./ports/work-repository.js";
import { runWorkLifecycleCommand } from "./run-work-lifecycle-command.js";
import type { WorkContextNotices } from "./work-context-notices.js";

type LifecycleDeps = {
  works: WorkRepository;
  workContextNotices: Pick<WorkContextNotices, "workChanged">;
};

type DeleteDeps = {
  works: WorkRepository;
  stopThreads(threadIds: readonly ThreadId[]): Promise<void>;
};

export type DeleteWorkTransition = { before: Work | null; after: Work | null; changed: boolean };

export async function deleteWorkTransition(
  deps: DeleteDeps,
  workId: WorkId,
): Promise<DeleteWorkTransition> {
  return runWorkLifecycleCommand(
    { transaction: deps.works.transaction, stopThreads: deps.stopThreads },
    async () => {
      // The tree's runs and subagent lineages end in this same transaction.
      const { before, after } = await deps.works.softDelete(workId, deps.stopThreads);
      const changed = !!after?.deletedAt && !before?.deletedAt;
      return { value: { before, after, changed }, threadIdsToStop: [] };
    },
  );
}

export async function restoreWork(deps: LifecycleDeps, workId: WorkId): Promise<Work> {
  return deps.works.transaction(async () => {
    const restoration = await deps.works.restore(workId);
    if (restoration.changed) {
      await deps.workContextNotices.workChanged(restoration.after.id);
    }
    return restoration.after;
  });
}
