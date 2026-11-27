/**
 * Which documents a draft may hold: its own project's, and the home folder of the account that
 * owns its project (`ownedByRequest`). Never widen this to another account's home folder or
 * another project's documents. Every check that pairs a draft with a document (draft
 * admission, file facts) asks here.
 */
import type { ProjectId, UserId } from "@meridian/contracts";
import type { TreeList } from "../ports/tree-list-store.js";
import { ownedByRequest } from "./source-owner.js";

export type DraftHolder = { projectId: ProjectId; accountId: UserId };

export type SourceOwner = { owner: TreeList; accountId: UserId; scheme: string };

export function draftMayHold(draft: DraftHolder, source: SourceOwner): boolean {
  return ownedByRequest(source.owner, draft);
}
