/**
 * Atomic ContextFS tree mutation contract shared by durable backends.
 * Moves/deletes use stable location fields as the CAS primitive. Content writes
 * may change document activity timestamps without invalidating a prepared tree
 * mutation.
 */
import type {
  ContextSiblingPosition,
  DeleteContextEntryResult,
  Filetype,
  RetractionCause,
} from "@meridian/contracts/protocol";
import type { Result } from "../../../shared/result.js";

export const CONTEXT_ROOT_DIRECTORY_ID = "__context_root__";

export type ContextLocationToken =
  | {
      kind: "file";
      /** Persisted documents.id row that was observed at `path`. */
      nodeId: string;
      /** context_sources.id for the tree that owned `path` when inspected. */
      sourceId: string;
      /** Normalized scheme-relative path that resolved to this node. */
      path: string;
      /** Persisted Yjs classification; null identifies a storage-backed document. */
      filetype: string | null;
      /** The stored name and extension: `binary` and `md` for a file kept as `binary.md`, which `path` alone cannot tell. */
      name: string;
      extension: string;
    }
  | {
      kind: "directory";
      /** Persisted folders.id row, or CONTEXT_ROOT_DIRECTORY_ID for a source root. */
      nodeId: string;
      /** context_sources.id for the tree that owned `path` when inspected. */
      sourceId: string;
      /** Normalized scheme-relative path that resolved to this node. */
      path: string;
    };

export type ContextTargetExpectation =
  | { state: "absent" }
  | { state: "occupied"; token: ContextLocationToken };

interface PreparedContextMoveBase {
  /** Source location inspected by ContextTreeMover; commit must prove it still resolves. */
  source: ContextLocationToken;
  /** Project whose holders the move note counts (contract §10); absent, the move counts nothing. */
  linkNoteProjectId?: string;
  /** Destination context_sources.id selected by URI routing. */
  destinationSourceId: string;
  destinationParentToken?: Extract<ContextLocationToken, { kind: "directory" }>;
  /** Validated suffix below destinationParentToken, ensured inside the commit transaction. */
  destinationCreateFolders?: string[];
  /** The final target path: the destination folder joined with the leaf. */
  destinationPath: string;
  /** Destination state inspected during preparation; commit must prove it has not changed. */
  expectedTarget: ContextTargetExpectation;
  position?: ContextSiblingPosition;
}

type PreparedFileMove = PreparedContextMoveBase & {
  /** Resolved by the destination codec; null keeps the file's type. */
  destinationFiletype: Filetype | null;
  /** The destination leaf's stored parts, parsed once by the mover; storage never re-parses them. */
  destinationFilename: { name: string; extension: string };
  source: Extract<ContextLocationToken, { kind: "file" }>;
};

type PreparedDirectoryMove = PreparedContextMoveBase & {
  source: Extract<ContextLocationToken, { kind: "directory" }>;
};

export type PreparedContextMove = PreparedFileMove | PreparedDirectoryMove;

type PreparedDirectoryMoveCommand = PreparedDirectoryMove & {
  destinationFiletype?: never;
};

/** Store-ready move command after ContextFS has resolved any filetype transition. */
export type ContextTreeMoveCommand = PreparedFileMove | PreparedDirectoryMoveCommand;

export type ContextTreeMutationError =
  | { code: "destination_missing" }
  | { code: "stale_source" }
  | { code: "stale_target" }
  | { code: "conflict"; occupantKind?: "file" | "folder" }
  | { code: "invalid_operation" }
  | { code: "not_found" };

export interface ContextTreeMutationResult {
  /** Moved document id for files, or moved root folder id for directory moves. */
  movedNodeId: string;
  /** Actual free path claimed by the move. */
  destinationPath: string;
  locationVersion?: string;
  linkUpdate?: { links: number; documents: number };
}

export interface ContextTreeDeleteResult {
  /** Exact deleted content identities. Empty-folder deletion has none. */
  removed: DeleteContextEntryResult["removed"];
  availabilityGeneration: string;
}

export type ContextTreeDeleteCommand = {
  actorUserId?: string;
  /** The chat whose model deleted it: the removal names "the AI in ‹chat›". */
  actorThreadId?: string;
  removal?: { reason: "discarded"; cause: RetractionCause };
  root: ContextLocationToken;
  mode: "recursive";
};

export interface ContextTreeMutationStore {
  inspect(sourceId: string, path: string): Promise<ContextLocationToken | null>;
  /**
   * The live node with this id, where it is now. The commits below recheck their source with
   * it, so a file and a folder answering at one path can't stand in for each other.
   */
  inspectNode(node: {
    kind: ContextLocationToken["kind"];
    id: string;
  }): Promise<ContextLocationToken | null>;
  /** Clear provisional naming under the same location CAS used by tree mutations. */
  commitProvisionalGraduation(
    source: Extract<ContextLocationToken, { kind: "file" }>,
  ): Promise<Result<void, ContextTreeMutationError>>;
  commitMove(
    input: ContextTreeMoveCommand,
  ): Promise<Result<ContextTreeMutationResult, ContextTreeMutationError>>;
  commitRecursiveDelete(
    command: ContextTreeDeleteCommand,
  ): Promise<Result<ContextTreeDeleteResult, ContextTreeMutationError>>;
}
