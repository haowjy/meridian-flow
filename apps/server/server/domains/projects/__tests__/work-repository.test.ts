import { describeWorkRepositoryConformance } from "../adapters/work-repository/__conformance__/work-repository.conformance.js";
import { createInMemoryWorkRepository } from "../adapters/work-repository/in-memory.js";

describeWorkRepositoryConformance("in-memory", createInMemoryWorkRepository);
