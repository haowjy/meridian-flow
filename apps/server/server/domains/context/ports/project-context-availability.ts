/** Ports for project-final identity reads and ambient availability ordering. */
import type {
  AvailabilityGeneration,
  ProjectContextIdentityLookupRequest,
  ProjectContextIdentityLookupResult,
} from "@meridian/contracts/protocol";

import type { TreeView } from "../tree/tree-view.js";

export interface ProjectContextAvailabilityPort {
  lookup(
    input: ProjectContextIdentityLookupRequest & {
      view?: TreeView;
      /**
       * In a branch view, the identities were addressed through their drafts (a review
       * address): a document deleted live whose draft in this branch outlived the delete is
       * available even when the branch has nothing pending to list it (a no-effect draft left
       * open; D79). Paths and links still follow the listing.
       */
      admitDrafts?: true;
    },
    actor: { userId: string },
  ): Promise<ProjectContextIdentityLookupResult>;
}

export interface ProjectContextAvailabilityMutationPort {
  /** Advance these authorities' availability generation. Publishes no namespace version:
   * authority-only changes (a Work's state or pending count) are not namespace changes. */
  advance(input: {
    projectIds: readonly string[];
    userIds: readonly string[];
  }): Promise<AvailabilityGeneration>;
  /** Allocate a fresh namespace observation version for these authorities in the ambient
   * transaction. Only a change to a live file, folder or source earns one. */
  publishNamespace(input: {
    projectIds: readonly string[];
    userIds: readonly string[];
  }): Promise<string>;
}
