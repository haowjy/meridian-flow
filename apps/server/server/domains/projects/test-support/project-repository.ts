import type { Database } from "@meridian/database";
import {
  createDrizzleProjectRepository,
  type DrizzleProjectRepositoryDeps,
} from "../adapters/project-repository/drizzle.js";
import {
  createDrizzleProjectBootstrapRepository,
  type ProjectBootstrapRepository,
} from "../index.js";

export function createProjectRepositoryForTest(
  deps: Omit<DrizzleProjectRepositoryDeps, "ensureNoWork"> &
    Partial<Pick<DrizzleProjectRepositoryDeps, "ensureNoWork">>,
) {
  return createDrizzleProjectRepository({
    db: deps.db as Database,
    ensureNoWork: deps.ensureNoWork ?? (async () => undefined),
  });
}

export function createProjectBootstrapRepositoryForTest(
  deps: Parameters<typeof createDrizzleProjectBootstrapRepository>[0],
): ProjectBootstrapRepository {
  return createDrizzleProjectBootstrapRepository(deps);
}
