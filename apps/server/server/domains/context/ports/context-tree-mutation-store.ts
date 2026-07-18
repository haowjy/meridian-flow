/**
 * Atomic ContextFS tree mutation contract shared by durable backends.
 * Moves/deletes use stable location fields as the CAS primitive. Content writes
 * may change document activity timestamps without invalidating a prepared tree
 * mutation.
 */
import type { Filetype } from "@meridian/contracts/protocol";
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
  /** Destination context_sources.id selected by URI routing. */
  destinationSourceId: string;
  /** Final normalized target path after Unix mv basename/directory resolution. */
  destinationPath: string;
  /** Destination state inspected during preparation; commit must prove it has not changed. */
  expectedTarget: ContextTargetExpectation;
  /** Explicit opt-in to replace an occupied file target. Directories are never overwritten. */
  overwrite: boolean;
}

type PreparedFileMove = PreparedContextMoveBase & {
  source: Extract<ContextLocationToken, { kind: "file" }>;
  /** The exact writer-location command ends provisional naming on commit. */
  graduateProvisionalName: boolean;
};

type PreparedDirectoryMove = PreparedContextMoveBase & {
  source: Extract<ContextLocationToken, { kind: "directory" }>;
};

export type PreparedContextMove = PreparedFileMove | PreparedDirectoryMove;

type PreparedFileMoveCommand = PreparedFileMove & {
  /** New persisted classification for a tracked file; null preserves storage-backed metadata. */
  destinationFiletype: Filetype | null;
};

type PreparedDirectoryMoveCommand = PreparedDirectoryMove & {
  destinationFiletype?: never;
};

/** Store-ready move command after ContextFS has resolved any filetype transition. */
export type ContextTreeMoveCommand = PreparedFileMoveCommand | PreparedDirectoryMoveCommand;

export type ContextTreeMutationError =
  | { code: "stale_source" }
  | { code: "stale_target" }
  | { code: "conflict" }
  | { code: "invalid_operation" }
  | { code: "not_found" };

export interface ContextTreeMutationResult {
  /** Moved document id for files, or moved root folder id for directory moves. */
  movedNodeId: string;
}

export interface ContextTreeDeleteResult {
  /** Document id for files, or folder id for directories. */
  deletedNodeId: string;
}

export interface ContextTreeMutationStore {
  inspect(sourceId: string, path: string): Promise<ContextLocationToken | null>;
  /** Clear provisional naming under the same location CAS used by tree mutations. */
  commitProvisionalGraduation(
    source: Extract<ContextLocationToken, { kind: "file" }>,
  ): Promise<Result<void, ContextTreeMutationError>>;
  commitMove(
    input: ContextTreeMoveCommand,
  ): Promise<Result<ContextTreeMutationResult, ContextTreeMutationError>>;
  commitDelete(
    token: ContextLocationToken,
  ): Promise<Result<ContextTreeDeleteResult, ContextTreeMutationError>>;
}
