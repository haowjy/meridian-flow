/**
 * Atomic ContextFS tree mutation contract shared by durable backends.
 * Key decision: moves/deletes use one location token as the CAS primitive, so
 * path inspection and durable mutation no longer depend on router-threaded
 * source facts or per-call adoption seams.
 */
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
      /** `documents.updated_at` observed at prepare — content-safe CAS revision. */
      revision: string;
    }
  | {
      kind: "directory";
      /** Persisted folders.id row, or CONTEXT_ROOT_DIRECTORY_ID for a source root. */
      nodeId: string;
      /** context_sources.id for the tree that owned `path` when inspected. */
      sourceId: string;
      /** Normalized scheme-relative path that resolved to this node. */
      path: string;
      /** `folders.updated_at` observed at prepare; empty for the synthetic source root. */
      revision: string;
    };

export type ContextTargetExpectation =
  | { state: "absent" }
  | { state: "occupied"; token: ContextLocationToken };

export interface PreparedContextMove {
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

export type ContextTreeMutationError =
  | { code: "stale_source" }
  | { code: "stale_target" }
  | { code: "conflict" }
  | { code: "invalid_operation" }
  | { code: "not_found" };

export interface ContextTreeMutationResult {
  /** Moved document id for files, or moved root folder id for directory moves. */
  movedNodeId: string;
  /** Document mirrors whose source row or overwrite target changed and must be evicted. */
  invalidatedDocumentIds: string[];
}

export interface ContextTreeDeleteResult {
  /** Document id for files, or folder id for directories. */
  deletedNodeId: string;
  /** Deleted tracked document mirrors that must be evicted after commit. */
  invalidatedDocumentIds: string[];
}

export interface ContextTreeMutationStore {
  inspect(sourceId: string, path: string): Promise<ContextLocationToken | null>;
  commitMove(
    input: PreparedContextMove,
  ): Promise<Result<ContextTreeMutationResult, ContextTreeMutationError>>;
  commitDelete(
    token: ContextLocationToken,
  ): Promise<Result<ContextTreeDeleteResult, ContextTreeMutationError>>;
}
