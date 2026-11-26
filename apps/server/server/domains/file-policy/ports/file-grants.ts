import type { UserId } from "@meridian/contracts/runtime";
import type { NodeGrant } from "../domain/policy.js";
import type { FileFacts } from "../domain/types.js";

export interface FileGrantsPort {
  personGrants(accountId: UserId, facts: FileFacts): Promise<readonly NodeGrant[]>;
}
