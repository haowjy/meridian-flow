/** In-memory half of the connected history contract. */
import type { ProjectId, UserId } from "@meridian/contracts/runtime";
import { createInMemoryRepositories } from "../../threads/adapters/in-memory/index.js";
import { defineThreadHistoryContract } from "./thread-history-contract.js";

defineThreadHistoryContract(async () => ({
  repos: createInMemoryRepositories(),
  projectId: crypto.randomUUID() as ProjectId,
  userId: crypto.randomUUID() as UserId,
}));
