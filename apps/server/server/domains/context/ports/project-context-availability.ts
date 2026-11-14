/** Ports for where a project holds its documents and folders now. */
import type { ContextUriScheme } from "@meridian/contracts/context-uri";
import type {
  CatalogFileEntry,
  CatalogFolderEntry,
  ProjectContextAuthority,
} from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";

import type { TreeView } from "../tree/tree-view.js";

/** Where this project holds a node, read by id and never through a Work authority. */
export type HeldContextNodeAddress = {
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
    }
  /** The project holds a node that no live address can name: in Trash, or inconsistent. */
  | { kind: "unreachable" };

/** What a view shows of the nodes asked about, held by the project or the writer's User area. */
export type PlacedNodes = {
  /** Documents the view shows, in a live source: absent from the map when in Trash or hidden. */
  documents: Map<string, { authority: ProjectContextAuthority; entry: CatalogFileEntry }>;
  folders: Map<string, { entry: CatalogFolderEntry }>;
  /** Documents whose source identity is inconsistent: shown by the view, yet not placeable. */
  inconsistent: Set<string>;
};

export interface ProjectContextAvailabilityPort {
  /** Throws when the project is not the actor's. */
  placed(
    input: {
      projectId: ProjectId;
      documentIds?: readonly string[];
      folderIds?: readonly string[];
      view?: TreeView;
    },
    actor: { userId: string },
  ): Promise<PlacedNodes>;
  /**
   * The address this project holds a node under in live, Trash included, read from the node and
   * its source rather than through a Work authority. Null when the project holds no such node (a
   * node in no live view is held by no one); `unreachable` when it holds one no live address can
   * name (in Trash, or an inconsistent identity).
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
