/** Creation of one live parent's new children: sibling folders and seeded tracked documents. */
import type { Filetype } from "@meridian/contracts/protocol";
import type { DocumentCreationMetadata } from "../document-metadata.js";

export type ContextChildrenInput = {
  /** The one parent every child lands under; `folderId: null` is the source root. */
  parent: { sourceId: string; folderId: string | null };
  folders: readonly { id: string; name: string }[];
  documents: readonly {
    id: string;
    name: string;
    extension: string;
    filetype: Filetype;
    metadata?: DocumentCreationMetadata;
  }[];
};

export interface ContextChildCreation {
  /** All identities, seeds, membership, arrivals and one catalog refresh commit together. */
  createChildren(input: ContextChildrenInput): Promise<void>;
}
