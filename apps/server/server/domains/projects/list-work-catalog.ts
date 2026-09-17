/** Owner-gated Work catalog projection, including collab-owned pending-draft counts. */
import type { ProjectId, UserId } from "@meridian/contracts/runtime";
import type {
  NamedWorkCatalogEntry,
  NoWorkCatalogEntry,
  WorksSnapshot,
} from "@meridian/contracts/works";
import type { ProjectRepository } from "./ports/project-repository.js";
import type { WorkDraftPendingCounts } from "./ports/work-draft-pending-counts.js";
import type { WorkRepository } from "./ports/work-repository.js";
import { requireProjectOwner } from "./project-access.js";

export async function listWorkCatalog(
  deps: {
    projects: ProjectRepository;
    works: Pick<
      WorkRepository,
      "readSnapshot" | "snapshotIdentity" | "listByProject" | "findNoWork"
    >;
    pendingDrafts: WorkDraftPendingCounts;
  },
  input: { projectId: ProjectId; userId: UserId },
  requestId = crypto.randomUUID(),
): Promise<WorksSnapshot> {
  return deps.works.readSnapshot(async () => {
    await requireProjectOwner({ projects: deps.projects }, input.projectId, input.userId);
    const identity = await deps.works.snapshotIdentity(input.projectId);
    const [works, noWork] = await Promise.all([
      deps.works.listByProject(input.projectId, { includeDeleted: true }),
      deps.works.findNoWork(input.projectId),
    ]);
    if (!noWork) throw new Error(`Project ${input.projectId} is missing No Work`);
    const counts = await deps.pendingDrafts.countPendingByWorkIds([
      ...works.map(({ id }) => id),
      noWork.id,
    ]);
    return {
      projectId: input.projectId,
      ...identity,
      requestId,
      works: works.map((work): NamedWorkCatalogEntry => {
        if (work.isNoWork || work.slug === null) {
          throw new Error(`Named Work catalog included locked Work ${work.id}`);
        }
        return {
          ...work,
          isNoWork: false,
          slug: work.slug,
          unpushedChangeCount: counts.get(work.id) ?? 0,
        };
      }),
      noWork: {
        ...noWork,
        isNoWork: true,
        slug: null,
        unpushedChangeCount: counts.get(noWork.id) ?? 0,
      } satisfies NoWorkCatalogEntry,
    };
  });
}
