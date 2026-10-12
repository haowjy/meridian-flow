/** Identity-based creation of one import planning chunk in a materialized context source. */
import type { Filetype } from "@meridian/contracts/protocol";
import type { DocumentCreationMetadata } from "../document-metadata.js";

export type ContextBulkCreationInput = {
  contextSourceId: string;
  folders: readonly { id: string; parentId: string | null; name: string }[];
  placeholders: readonly {
    id: string;
    folderId: string | null;
    name: string;
    extension: string;
    filetype: Filetype;
    metadata?: DocumentCreationMetadata;
  }[];
};

export interface ContextBulkCreation {
  /** All identities, seeds, membership, arrivals and one catalog refresh commit together. */
  create(input: ContextBulkCreationInput): Promise<void>;
}
