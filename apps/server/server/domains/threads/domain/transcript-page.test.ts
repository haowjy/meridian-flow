/** In-memory half of the shared transcript reader contract. */

import type { ProjectId, UserId } from "@meridian/contracts/runtime";
import { defineTranscriptPageContract } from "../__conformance__/transcript-page-contract.js";
import { createInMemoryRepositories } from "../adapters/in-memory/index.js";

defineTranscriptPageContract(async () => ({
  repos: createInMemoryRepositories(),
  projectId: crypto.randomUUID() as ProjectId,
  userId: crypto.randomUUID() as UserId,
}));
