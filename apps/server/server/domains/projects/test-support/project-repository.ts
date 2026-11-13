import type { Database } from "@meridian/database";
import { createLocalFileAccessChanges } from "../../file-policy/index.js";
import {
  createDrizzleProjectRepository,
  type DrizzleProjectRepositoryDeps,
} from "../adapters/project-repository/drizzle.js";
import {
  createDrizzleProjectBootstrapRepository,
  type ProjectBootstrapRepository,
} from "../index.js";

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
  deps: Parameters<typeof createDrizzleProjectBootstrapRepository>[0],
): ProjectBootstrapRepository {
  return createDrizzleProjectBootstrapRepository(deps);
}
