/**
 * Port: a person's grants on a file and its ancestors (file-access §3.1).
 * Sharing replaces the adapter; the policy reads the same answer.
 */
import type { UserId } from "@meridian/contracts/runtime";
import type { NodeGrant } from "../domain/policy.js";
import type { FileFacts } from "../domain/types.js";

export interface FileGrantsPort {
  personGrants(accountId: UserId, facts: FileFacts): Promise<readonly NodeGrant[]>;
}
