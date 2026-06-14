import { describeProjectRepositoryConformance } from "../adapters/project-repository/__conformance__/project-repository.conformance.js";
import { createInMemoryProjectRepository } from "../adapters/project-repository/in-memory.js";

describeProjectRepositoryConformance("in-memory", createInMemoryProjectRepository);
