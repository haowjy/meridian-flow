/** Owner-gated Work catalog projection, including collab-owned pending-draft counts. */
import type { ProjectId, UserId } from "@meridian/contracts/runtime";
import type { Work, WorkStatus } from "@meridian/contracts/works";
import type { ProjectRepository } from "./ports/project-repository.js";
import type { WorkDraftPendingCounts } from "./ports/work-draft-pending-counts.js";
import type { WorkRepository } from "./ports/work-repository.js";
import { requireProjectOwner } from "./project-access.js";

export type WorkCatalogEntry = Work & { unpushedChangeCount: number };

export async function listWorkCatalog(
  deps: {
    projects: ProjectRepository;
    works: Pick<WorkRepository, "listByProject">;
    pendingDrafts: WorkDraftPendingCounts;
  },
  input: { projectId: ProjectId; userId: UserId; status?: WorkStatus },
): Promise<WorkCatalogEntry[]> {
  await requireProjectOwner({ projects: deps.projects }, input.projectId, input.userId);
  const works = await deps.works.listByProject(
    input.projectId,
    input.status === undefined ? undefined : { status: input.status },
  );
  const counts = await deps.pendingDrafts.countPendingByWorkIds(works.map(({ id }) => id));
  return works.map((work) => ({
    ...work,
    unpushedChangeCount: counts.get(work.id) ?? 0,
  }));
}
