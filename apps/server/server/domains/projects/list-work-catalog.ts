/** Owner-gated Work catalog projection; each Work carries its stored pending-document count. */
import type { ProjectId, UserId } from "@meridian/contracts/runtime";
import type {
  NamedWorkCatalogEntry,
  NoWorkCatalogEntry,
  WorksSnapshot,
} from "@meridian/contracts/works";
import type { ProjectRepository } from "./ports/project-repository.js";
import type { WorkRepository } from "./ports/work-repository.js";
import { requireProjectOwner } from "./project-access.js";

export async function listWorkCatalog(
  deps: {
    projects: ProjectRepository;
    works: Pick<
      WorkRepository,
      "readSnapshot" | "snapshotIdentity" | "listByProject" | "findNoWork"
    >;
  },
  input: { projectId: ProjectId; userId: UserId },
  requestId = crypto.randomUUID(),
): Promise<WorksSnapshot> {
  return deps.works.readSnapshot(async () => {
    await requireProjectOwner({ projects: deps.projects }, input.projectId, input.userId);
    const identity = await deps.works.snapshotIdentity(input.projectId);
    const [works, noWork] = await Promise.all([
      deps.works.listByProject(input.projectId, { includeDeleted: true, lifecycle: "all" }),
      deps.works.findNoWork(input.projectId),
    ]);
    if (!noWork) throw new Error(`Project ${input.projectId} is missing No Work`);
    return {
      projectId: input.projectId,
      ...identity,
      requestId,
      works: works.map((work): NamedWorkCatalogEntry => {
        if (work.isNoWork || work.handle === null) {
          throw new Error(`Named Work catalog included locked Work ${work.id}`);
        }
        return { ...work, isNoWork: false, handle: work.handle };
      }),
      noWork: { ...noWork, isNoWork: true, handle: null } satisfies NoWorkCatalogEntry,
    };
  });
}
