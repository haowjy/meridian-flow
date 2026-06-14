/** In-memory preferences adapter test: runs the shared project preferences repository conformance suite. */
import { describeProjectPreferencesRepositoryConformance } from "../__conformance__/project-preferences-repository.conformance.js";
import { createInMemoryProjectPreferencesRepository } from "./project-preferences-repository.js";

describeProjectPreferencesRepositoryConformance(
  "in-memory",
  createInMemoryProjectPreferencesRepository,
);
