import { createInMemoryPackageStore } from "./in-memory-package-store.js";

export function createDrizzlePackageStore(_db: unknown) {
  return createInMemoryPackageStore();
}
