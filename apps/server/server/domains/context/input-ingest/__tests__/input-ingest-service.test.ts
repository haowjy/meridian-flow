/**
 * Input ingest service tests: object store → run-scoped writable input paths
 * with honest abort semantics (no consumable partial at the final path).
 */

import { describe, expect, it } from "vitest";
import { createInMemoryObjectStore } from "../../../storage/index.js";
import { type BinaryFileSink, createInputIngestService } from "../input-ingest-service.js";

class MemoryWritableFiles implements BinaryFileSink {
  readonly writes: Array<{ path: string; bytes: Uint8Array }> = [];
  readonly folders: string[] = [];
  failOnPath: string | null = null;

  async readFileBinary(remotePath: string): Promise<Uint8Array> {
    const match = this.writes.find((entry) => entry.path === remotePath);
    if (!match) throw new Error(`file not found: ${remotePath}`);
    return match.bytes;
  }

  async writeFileBinary(remotePath: string, content: Uint8Array): Promise<void> {
    if (this.failOnPath === remotePath) throw new Error("simulated transfer interruption");
    this.writes.push({ path: remotePath, bytes: content });
  }

  async createFolder(path: string): Promise<void> {
    this.folders.push(path);
  }
}

describe("createInputIngestService", () => {
  it("hydrates object-store keys into run-scoped input paths", async () => {
    const objectStore = createInMemoryObjectStore();
    const payload = Uint8Array.from([9, 8, 7, 6]);
    const put = await objectStore.put("uploads/dataset/labels.nii.gz", payload, "application/gzip");
    expect(put.ok).toBe(true);
    if (!put.ok) return;

    const files = new MemoryWritableFiles();
    const service = createInputIngestService({
      objectStore,
      getWritableFiles: async () => files,
    });

    const result = await service.hydrateRunInput({
      rootThreadId: "thread-root",
      files: [{ objectKey: "uploads/dataset/labels.nii.gz", relativePath: "labels.nii.gz" }],
    });

    expect(result).toEqual({
      ok: true,
      value: [
        {
          objectKey: "uploads/dataset/labels.nii.gz",
          relativePath: "labels.nii.gz",
          sourcePath: "runs/thread-root/input/labels.nii.gz",
          sizeBytes: 4,
        },
      ],
    });
    expect(files.folders).toEqual(["runs/thread-root/input"]);
    await expect(files.readFileBinary("runs/thread-root/input/labels.nii.gz")).resolves.toEqual(
      payload,
    );
  });

  it("returns context_io_error without leaving a final-path file after mid-transfer failure", async () => {
    const objectStore = createInMemoryObjectStore();
    await objectStore.put(
      "uploads/dataset/labels.nii.gz",
      Uint8Array.from([1, 2, 3]),
      "application/gzip",
    );

    const files = new MemoryWritableFiles();
    files.failOnPath = "runs/thread-root/input/labels.nii.gz";

    const service = createInputIngestService({
      objectStore,
      getWritableFiles: async () => files,
    });

    const result = await service.hydrateRunInput({
      rootThreadId: "thread-root",
      files: [{ objectKey: "uploads/dataset/labels.nii.gz", relativePath: "labels.nii.gz" }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("context_io_error");
    await expect(files.readFileBinary("runs/thread-root/input/labels.nii.gz")).rejects.toThrow(
      /not found/i,
    );
  });

  it("honors abort before writing", async () => {
    const objectStore = createInMemoryObjectStore();
    await objectStore.put(
      "uploads/dataset/a.bin",
      Uint8Array.from([1]),
      "application/octet-stream",
    );

    const files = new MemoryWritableFiles();
    const controller = new AbortController();
    controller.abort();

    const service = createInputIngestService({
      objectStore,
      getWritableFiles: async () => files,
    });

    const result = await service.hydrateRunInput({
      rootThreadId: "thread-root",
      files: [{ objectKey: "uploads/dataset/a.bin", relativePath: "a.bin" }],
      signal: controller.signal,
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "aborted", message: "Input ingest aborted" },
    });
    expect(files.writes).toHaveLength(0);
  });
});
