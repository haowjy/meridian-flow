import { describePackageRepositoryConformance } from "./__conformance__/package-repository.conformance.js";
import { createInMemoryPackageStore } from "./in-memory-package-store.js";

describePackageRepositoryConformance("in-memory", createInMemoryPackageStore);
