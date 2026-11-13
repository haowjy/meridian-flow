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
import type { ContextCatalogLifecyclePort } from "../ports/context-catalog-lifecycle.js";

export const noOpProjectCatalogLifecycle: ContextCatalogLifecyclePort = {
  async refreshProject() {},
  async upsertWorkAuthorities() {},
  publishDraftOwnerHints() {},
};

export function createProjectRepositoryForTest(
  deps: Omit<
    DrizzleProjectRepositoryDeps,
    "catalogLifecycle" | "ensureNoWork" | "fileAccessChanges"
  > &
    Partial<
      Pick<DrizzleProjectRepositoryDeps, "catalogLifecycle" | "ensureNoWork" | "fileAccessChanges">
    >,
) {
  return createDrizzleProjectRepository({
    db: deps.db as Database,
    catalogLifecycle: deps.catalogLifecycle ?? noOpProjectCatalogLifecycle,
    ensureNoWork: deps.ensureNoWork ?? (async () => undefined),
    fileAccessChanges: deps.fileAccessChanges ?? createLocalFileAccessChanges(),
  });
}

export function createProjectBootstrapRepositoryForTest(
  deps: Omit<Parameters<typeof createDrizzleProjectBootstrapRepository>[0], "catalogLifecycle"> & {
    catalogLifecycle?: ContextCatalogLifecyclePort;
  },
): ProjectBootstrapRepository {
  return createDrizzleProjectBootstrapRepository({
    ...deps,
    catalogLifecycle: deps.catalogLifecycle ?? noOpProjectCatalogLifecycle,
  });
}
