/** Owner-gated Work catalog projection, including collab-owned pending-draft counts. */
import type { ProjectId, UserId } from "@meridian/contracts/runtime";
import type { WorkCatalogEntry, WorksSnapshot } from "@meridian/contracts/works";
import type { ProjectRepository } from "./ports/project-repository.js";
import type { WorkDraftPendingCounts } from "./ports/work-draft-pending-counts.js";
import type { WorkRepository } from "./ports/work-repository.js";
import { requireProjectOwner } from "./project-access.js";

export async function listWorkCatalog(
  deps: {
    projects: ProjectRepository;
    works: Pick<WorkRepository, "readSnapshot" | "snapshotIdentity" | "listByProject">;
    pendingDrafts: WorkDraftPendingCounts;
  },
  input: { projectId: ProjectId; userId: UserId },
  requestId = crypto.randomUUID(),
): Promise<WorksSnapshot> {
  return deps.works.readSnapshot(async () => {
    await requireProjectOwner({ projects: deps.projects }, input.projectId, input.userId);
    const identity = await deps.works.snapshotIdentity(input.projectId);
    const works = await deps.works.listByProject(input.projectId, { includeDeleted: true });
    const counts = await deps.pendingDrafts.countPendingByWorkIds(works.map(({ id }) => id));
    return {
      projectId: input.projectId,
      ...identity,
      requestId,
      works: works.map(
        (work): WorkCatalogEntry => ({
          ...work,
          unpushedChangeCount: counts.get(work.id) ?? 0,
        }),
      ),
    };
  });
}
