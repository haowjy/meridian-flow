/**
 * Checkpoint flush manifest + rehydrate: bulk-promote generated artifacts at a
 * checkpoint boundary; restore bytes from the manifest when the writable file
 * context is recreated. Mirror of input-ingest — reuses parent-folder helpers
 * and objectStore.get.
 */
import type { ArtifactRef } from "@meridian/contracts/interrupt";
import { objectStoreKeyFromStorageUrl } from "../../storage/object-storage-url.js";
import type { ObjectStorePort } from "../../storage/ports/object-store.js";
import { parentSourcePath } from "./artifact-paths.js";
import { evaluatePromotionPolicy } from "./promotion-policy.js";
import type { PromotedArtifact, PromotionService } from "./promotion-service.js";
import type { ResultProvenance } from "./result-provenance.js";

export interface BinaryFileSource {
  readFileBinary(path: string): Promise<Uint8Array>;
}

export interface BinaryFileTarget {
  createFolder(path: string): Promise<void>;
  writeFileBinary(path: string, bytes: Uint8Array): Promise<void>;
}

export interface CheckpointFlushManifestEntry {
  sourcePath: string;
  objectKey: string;
  storageUrl: string;
  mimeType: string;
  sizeBytes: number;
  resultId: string;
  resultsUri: string;
}

/** JSON-natural manifest persisted or passed between flush and rehydrate. */
export interface CheckpointFlushManifest {
  version: 1;
  rootThreadId: string;
  threadId: string;
  turnId: string;
  agentSlug: string;
  flushedAt: string;
  entries: CheckpointFlushManifestEntry[];
}

export type CheckpointFlushErrorCode =
  | "invalid_input"
  | "context_unavailable"
  | "context_io_error"
  | "object_store_error"
  | "promotion_failed";

export interface CheckpointFlushError {
  code: CheckpointFlushErrorCode;
  message: string;
}

export type CheckpointFlushResult =
  | { ok: true; value: CheckpointFlushManifest }
  | { ok: false; error: CheckpointFlushError };

export type RehydrateResult =
  | { ok: true; value: { restoredPaths: string[] } }
  | { ok: false; error: CheckpointFlushError };

export interface FlushAtCheckpointInput {
  projectId: string;
  workId: string;
  provenance: ResultProvenance;
  /** Writable-context-relative paths to promote; policy may skip ineligible paths. */
  sourcePaths: string[];
}

export interface RehydrateFromManifestInput {
  manifest: CheckpointFlushManifest;
  signal?: AbortSignal;
}

export interface CheckpointFlushService {
  flushAtCheckpoint(input: FlushAtCheckpointInput): Promise<CheckpointFlushResult>;
  rehydrateFromManifest(input: RehydrateFromManifestInput): Promise<RehydrateResult>;
}

export interface CheckpointFlushServiceDeps {
  promotion: PromotionService;
  objectStore: ObjectStorePort;
  getReadableFiles: () => Promise<BinaryFileSource | null>;
  getWritableFiles: () => Promise<BinaryFileTarget | null>;
}

function flushErr(code: CheckpointFlushErrorCode, message: string): CheckpointFlushResult {
  return { ok: false, error: { code, message } };
}

function rehydrateErr(code: CheckpointFlushErrorCode, message: string): RehydrateResult {
  return { ok: false, error: { code, message } };
}

/** Extract manuscript/bare source paths from checkpoint artifact refs. */
export function sourcePathsFromArtifactRefs(artifacts: ArtifactRef[]): string[] {
  const paths = new Set<string>();
  for (const artifact of artifacts) {
    if (artifact.type !== "object") continue;
    const path = artifactUriToSourcePath(artifact.uri);
    if (path) paths.add(path);
  }
  return [...paths];
}

function artifactUriToSourcePath(uri: string): string | null {
  const trimmed = uri.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("manuscript://"))
    return trimmed.slice("manuscript://".length).replace(/^\/+/, "");
  if (!trimmed.includes("://")) return trimmed.replace(/^\/+/, "");
  return null;
}

function manifestEntryFromPromotion(promoted: PromotedArtifact): CheckpointFlushManifestEntry {
  return {
    sourcePath: promoted.sourcePath,
    objectKey: promoted.objectKey,
    storageUrl: promoted.storageUrl,
    mimeType: promoted.mimeType,
    sizeBytes: promoted.sizeBytes,
    resultId: promoted.resultId,
    resultsUri: promoted.resultsUri,
  };
}

async function ensureParentFolders(files: BinaryFileTarget, remotePath: string): Promise<void> {
  const parent = parentSourcePath(remotePath);
  if (parent !== ".") await files.createFolder(parent);
}

export function createCheckpointFlushService(
  deps: CheckpointFlushServiceDeps,
): CheckpointFlushService {
  return {
    async flushAtCheckpoint(input): Promise<CheckpointFlushResult> {
      if (!input.projectId) return flushErr("invalid_input", "projectId is required");
      if (!input.workId) return flushErr("invalid_input", "workId is required");
      if (input.sourcePaths.length === 0) {
        return flushErr("invalid_input", "At least one source path is required");
      }

      const files = await deps.getReadableFiles();
      if (!files) return flushErr("context_unavailable", "Readable file context is unavailable");

      const entries: CheckpointFlushManifestEntry[] = [];
      const seen = new Set<string>();

      for (const rawPath of input.sourcePaths) {
        const sourcePath = rawPath.replace(/^\/+/, "");
        if (!sourcePath || seen.has(sourcePath)) continue;
        seen.add(sourcePath);

        if (evaluatePromotionPolicy(sourcePath).decision === "skip") continue;

        let bytes: Uint8Array;
        try {
          bytes = await files.readFileBinary(sourcePath);
        } catch (error) {
          return flushErr(
            "context_io_error",
            error instanceof Error ? error.message : "File read failed",
          );
        }

        const promoted = await deps.promotion.promoteArtifact({
          projectId: input.projectId,
          workId: input.workId,
          sourcePath,
          bytes,
          provenance: input.provenance,
        });
        if (!promoted.ok) {
          if (promoted.error.code === "policy_skip") continue;
          return flushErr("promotion_failed", promoted.error.message);
        }
        entries.push(manifestEntryFromPromotion(promoted.value));
      }

      return {
        ok: true,
        value: {
          version: 1,
          rootThreadId: input.provenance.rootThreadId,
          threadId: input.provenance.threadId,
          turnId: input.provenance.turnId,
          agentSlug: input.provenance.agentSlug,
          flushedAt: new Date().toISOString(),
          entries,
        },
      };
    },

    async rehydrateFromManifest(input): Promise<RehydrateResult> {
      const manifest = input.manifest;
      if (manifest.version !== 1)
        return rehydrateErr("invalid_input", "Unsupported manifest version");
      if (manifest.entries.length === 0)
        return rehydrateErr("invalid_input", "Manifest has no entries");

      const files = await deps.getWritableFiles();
      if (!files)
        return rehydrateErr("context_unavailable", "Writable file context is unavailable");

      const restoredPaths: string[] = [];

      for (const entry of manifest.entries) {
        if (input.signal?.aborted) return rehydrateErr("context_io_error", "Rehydrate aborted");

        const objectKey = entry.objectKey || objectStoreKeyFromStorageUrl(entry.storageUrl) || null;
        if (!objectKey)
          return rehydrateErr("invalid_input", `Invalid storage URL: ${entry.storageUrl}`);

        const stored = await deps.objectStore.get(objectKey);
        if (!stored.ok) return rehydrateErr("object_store_error", stored.error.message);

        try {
          await ensureParentFolders(files, entry.sourcePath);
          await files.writeFileBinary(entry.sourcePath, stored.value.bytes);
        } catch (error) {
          return rehydrateErr(
            "context_io_error",
            error instanceof Error ? error.message : "File write failed",
          );
        }

        restoredPaths.push(entry.sourcePath);
      }

      return { ok: true, value: { restoredPaths } };
    },
  };
}
