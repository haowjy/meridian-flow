import type { Database } from "@meridian/database";
import { createTestWorkProjectionMutation } from "../../../test-support/work-projection.js";
import { createDrizzleLineageScratchLifecycle } from "../../context/index.js";
import { createLocalFileAccessChanges } from "../../file-policy/index.js";
import {
  createDrizzleProjectBootstrapRepository,
  type ProjectBootstrapRepository,
} from "../adapters/drizzle-project-bootstrap.js";
import {
  createDrizzleProjectRepository,
  type DrizzleProjectRepositoryDeps,
} from "../adapters/project-repository/drizzle.js";
import { createDrizzleWorkRepository } from "../adapters/work-repository/drizzle.js";

export function createProjectRepositoryForTest(
  deps: Omit<DrizzleProjectRepositoryDeps, "ensureNoWork" | "fileAccessChanges"> &
    Partial<Pick<DrizzleProjectRepositoryDeps, "ensureNoWork" | "fileAccessChanges">>,
) {
  return createDrizzleProjectRepository({
    db: deps.db as Database,
    ensureNoWork: deps.ensureNoWork ?? (async () => undefined),
    fileAccessChanges: deps.fileAccessChanges ?? createLocalFileAccessChanges(),
  });
}

export function createProjectBootstrapRepositoryForTest(
  deps: Omit<Parameters<typeof createDrizzleProjectBootstrapRepository>[0], "projects">,
): ProjectBootstrapRepository {
  const fileAccessChanges = createLocalFileAccessChanges();
  const works = createDrizzleWorkRepository({
    db: deps.db,
    projectionMutation: createTestWorkProjectionMutation(deps.db),
    fileAccessChanges,
    lineageScratch: createDrizzleLineageScratchLifecycle(deps.db),
  });
  return createDrizzleProjectBootstrapRepository({
    ...deps,
    projects: createDrizzleProjectRepository({
      db: deps.db,
      fileAccessChanges,
      ensureNoWork: (projectId) => works.ensureNoWork(projectId),
    }),
  });
}
