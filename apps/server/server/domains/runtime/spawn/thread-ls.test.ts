/** In-memory half of the connected history contract.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Connected-graph listing traversal
 */
import type { ProjectId, UserId } from "@meridian/contracts/runtime";
import { createInMemoryRepositories } from "../../threads/adapters/in-memory/index.js";
import { defineThreadLsContract } from "./thread-ls-contract.js";

defineThreadLsContract(async () => ({
  repos: createInMemoryRepositories(),
  projectId: crypto.randomUUID() as ProjectId,
  userId: crypto.randomUUID() as UserId,
}));
