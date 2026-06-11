export type ProjectRepository = {
  readonly phase: "skeleton";
};

export type WorkRepository = {
  readonly phase: "skeleton";
};

export function createInMemoryProjectRepository(): ProjectRepository {
  return { phase: "skeleton" };
}

export function createInMemoryWorkRepository(): WorkRepository {
  return { phase: "skeleton" };
}

export function createDrizzleProjectRepository(_db: unknown): ProjectRepository {
  return createInMemoryProjectRepository();
}

export function createDrizzleWorkRepository(_db: unknown): WorkRepository {
  return createInMemoryWorkRepository();
}
