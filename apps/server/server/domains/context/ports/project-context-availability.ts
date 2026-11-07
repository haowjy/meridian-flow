/** Ports for project-final identity reads and ambient availability ordering. */
import type { ContextUriScheme } from "@meridian/contracts/context-uri";
import type {
  AvailabilityGeneration,
  ProjectContextIdentityLookupRequest,
  ProjectContextIdentityLookupResult,
} from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";

import type { TreeView } from "../tree/tree-view.js";

/** Where this project holds a node, read by id and never through a Work authority. */
export type HeldContextNodeAddress = {
  /** The identity actually held: a forwarded document's current id, else the requested one. */
  id: string;
  scheme: ContextUriScheme;
  path: string;
  name: string;
  workId: string | null;
  uri: string;
};

export type HeldContextNode =
  | {
      kind: "held";
      address: HeldContextNodeAddress;
      /** The requested document id was forwarded to `address.id` (a join). */
      forwarded: boolean;
    }
  /** The project holds a row that no live address can name: deleted, hidden, or inconsistent. */
  | { kind: "unreachable" };

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
  /**
   * The address this project holds a node under, whatever the node's visibility, read from the
   * row and its source rather than through a Work authority: a create's replay must answer for a
   * tree whose Work the route can no longer resolve. Null when the project holds no such row;
   * `unreachable` when it holds one no live address can name (deleted, hidden, or an inconsistent
   * identity), which a create answers as a conflict.
   */
  held(
    input: {
      projectId: ProjectId;
      node: { kind: "document"; id: DocumentId } | { kind: "folder"; id: string };
    },
    actor: { userId: string },
  ): Promise<HeldContextNode | null>;
  /**
   * Runs a create's whole decision for one entry id alone: the held read, every refusal, and the
   * claim. Creates of the same id queue, so a replay reads what an earlier send committed or
   * rolled back, and a refusal means no such id is held. Without it the read precedes the claim,
   * and a replay refused for an authority that changed meanwhile can be answered "free" for an
   * id the first send then commits.
   */
  serializeCreate<T>(entryId: string, create: () => Promise<T>): Promise<T>;
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
