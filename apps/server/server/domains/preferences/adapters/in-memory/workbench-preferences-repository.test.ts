/** In-memory preferences adapter test: runs the shared workbench preferences repository conformance suite. */
import { describeWorkbenchPreferencesRepositoryConformance } from "../__conformance__/workbench-preferences-repository.conformance.js";
import { createInMemoryWorkbenchPreferencesRepository } from "./workbench-preferences-repository.js";

describeWorkbenchPreferencesRepositoryConformance(
  "in-memory",
  createInMemoryWorkbenchPreferencesRepository,
);
