/** v1 grants: the project's owner gets `edit` on it, and nobody else has any. */
import type { FileGrantsPort } from "../ports/file-grants.js";

export function createOwnerFileGrants(): FileGrantsPort {
  return {
    async personGrants(accountId, facts) {
      return accountId === facts.ownerAccountId
        ? [{ node: { kind: "project", id: facts.projectId }, level: "edit" }]
        : [];
    },
  };
}
