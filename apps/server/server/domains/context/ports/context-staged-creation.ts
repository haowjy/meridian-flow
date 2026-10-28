/** Private creation batches and their all-or-nothing publication into project areas. */
import type { AheadMint } from "@meridian/agent-edit/integration";
import type { Filetype } from "@meridian/contracts/protocol";
import type { DocumentSeedOrigin, PreparedSeed } from "../../collab/index.js";
import type { DocumentCreationMetadata } from "../document-metadata.js";

export type ContextArea = "manuscript" | "kb" | "unfiled";
type StagedNode = { id: string; parentId: string | null; area: ContextArea; name: string };
export type ContextStage = {
  folders: readonly StagedNode[];
  documents: readonly (StagedNode & {
    extension: string;
    filetype: Filetype;
    metadata?: DocumentCreationMetadata;
    origin: DocumentSeedOrigin;
    content:
      | { kind: "tracked"; seed: PreparedSeed; aheadMints: readonly AheadMint[] }
      | {
          kind: "binary";
          storageUrl: string;
          mimeType: string;
          sizeBytes: number;
          hasPreview: boolean;
        };
  })[];
};
export type ContextPlacement = {
  generation: number;
  destinations: readonly { area: ContextArea; folderId: string | null; uri: string }[];
  /** Node id to allocated stem (without a document's extension). */
  topLevelNames: ReadonlyMap<string, string>;
};
export interface ContextStagedCreation {
  /** Caller owns the transaction and fences the stage owner, project and generation. */
  stage(stagingId: string, generation: number, nodes: ContextStage): Promise<void>;
  /** Caller keeps its owner/project lifecycle gate until commit; a changed placement writes nothing. */
  commitStaged(
    stagingId: string,
    expected: ContextPlacement,
  ): Promise<{ kind: "committed"; sourceIds: string[] } | { kind: "changed" }>;
  /** At most limit rows from each staging table, inside one short transaction. */
  discardStaged(stagingId: string, limit?: number): Promise<{ remaining: boolean }>;
}
