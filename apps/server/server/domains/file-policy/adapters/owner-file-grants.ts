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
