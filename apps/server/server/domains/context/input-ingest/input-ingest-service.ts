import { type ObjectStorePort, objectStoreKeyFromStorageUrl } from "../../storage/index.js";
import { parentSourcePath, runScopedInputPath } from "./run-input-paths.js";

export interface BinaryFileSink {
  createFolder(path: string): Promise<void>;
  writeFileBinary(path: string, bytes: Uint8Array): Promise<void>;
}
export type InputIngestErrorCode =
  | "object_store_error"
  | "context_unavailable"
  | "context_io_error"
  | "aborted"
  | "invalid_input";
export interface InputIngestError {
  code: InputIngestErrorCode;
  message: string;
}
export interface InputIngestFile {
  objectKey: string;
  relativePath: string;
}
export interface InputIngestInput {
  rootThreadId: string;
  files: InputIngestFile[];
  signal?: AbortSignal;
}
export interface InputIngestResultEntry {
  objectKey: string;
  relativePath: string;
  sourcePath: string;
  sizeBytes: number;
}
export type InputIngestResult =
  | { ok: true; value: InputIngestResultEntry[] }
  | { ok: false; error: InputIngestError };
export interface InputIngestService {
  hydrateRunInput(input: InputIngestInput): Promise<InputIngestResult>;
}
export interface InputIngestServiceDeps {
  objectStore: ObjectStorePort;
  getWritableFiles: () => Promise<BinaryFileSink | null>;
}
const err = (code: InputIngestErrorCode, message: string): InputIngestResult => ({
  ok: false,
  error: { code, message },
});
const resolveObjectKey = (objectKeyOrUrl: string): string | null =>
  objectStoreKeyFromStorageUrl(objectKeyOrUrl) ?? objectKeyOrUrl;
function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}
async function ensureParentFolders(files: BinaryFileSink, remotePath: string): Promise<void> {
  const parent = parentSourcePath(remotePath);
  if (parent !== ".") await files.createFolder(parent);
}
export function createInputIngestService(deps: InputIngestServiceDeps): InputIngestService {
  return {
    async hydrateRunInput(input): Promise<InputIngestResult> {
      if (!input.rootThreadId) return err("invalid_input", "rootThreadId is required");
      if (input.files.length === 0) return err("invalid_input", "At least one file is required");
      const files = await deps.getWritableFiles();
      if (!files) return err("context_unavailable", "Writable file context is unavailable");
      const hydrated: InputIngestResultEntry[] = [];
      for (const file of input.files) {
        if (input.signal?.aborted) return err("aborted", "Input ingest aborted");
        const objectKey = resolveObjectKey(file.objectKey);
        if (!objectKey) return err("invalid_input", `Invalid object key: ${file.objectKey}`);
        let sourcePath: string;
        try {
          sourcePath = runScopedInputPath(input.rootThreadId, file.relativePath);
        } catch (error) {
          return err(
            "invalid_input",
            error instanceof Error ? error.message : "Invalid relative path",
          );
        }
        const stored = await deps.objectStore.get(objectKey);
        if (!stored.ok) return err("object_store_error", stored.error.message);
        if (input.signal?.aborted) return err("aborted", "Input ingest aborted");
        try {
          await ensureParentFolders(files, sourcePath);
          await files.writeFileBinary(sourcePath, stored.value.bytes);
        } catch (error) {
          if (isAbortError(error) || input.signal?.aborted)
            return err("aborted", "Input ingest aborted during file write");
          return err(
            "context_io_error",
            error instanceof Error ? error.message : "File write failed",
          );
        }
        hydrated.push({
          objectKey,
          relativePath: file.relativePath,
          sourcePath,
          sizeBytes: stored.value.bytes.byteLength,
        });
      }
      return { ok: true, value: hydrated };
    },
  };
}
