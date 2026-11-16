/**
 * v1 grants: the owner gets `edit` on what it owns, a project or its own home folder, and nobody
 * else has any. Behind `project-context-availability`, this keeps one writer out of another's `~`.
 */
import { ownerNode } from "../domain/types.js";
import type { FileGrantsPort } from "../ports/file-grants.js";

export function createOwnerFileGrants(): FileGrantsPort {
  return {
    async personGrants(accountId, facts) {
      return accountId === facts.ownerAccountId
        ? [{ node: ownerNode(facts.owner), level: "edit" }]
        : [];
    },
  };
}
