export type AgentPackageStore = {
  readonly phase: "skeleton";
};

export function createInMemoryPackageStore(): AgentPackageStore {
  return { phase: "skeleton" };
}

export function createDrizzlePackageStore(_db: unknown): AgentPackageStore {
  return createInMemoryPackageStore();
}
