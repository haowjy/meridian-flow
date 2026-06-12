import { describeWorkbenchRepositoryConformance } from "../adapters/workbench-repository/__conformance__/workbench-repository.conformance.js";
import { createInMemoryWorkbenchRepository } from "../adapters/workbench-repository/in-memory.js";

describeWorkbenchRepositoryConformance("in-memory", createInMemoryWorkbenchRepository);
