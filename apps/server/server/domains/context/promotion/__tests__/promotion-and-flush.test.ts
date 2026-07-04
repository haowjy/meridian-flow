/**
 * Promotion + interrupt flush/rehydrate: service-level tests with in-memory adapters.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryObjectStore } from "../../../storage/index.js";
import { createInMemoryResultRepository } from "../adapters/in-memory-result-repository.js";
import {
  type BinaryFileSource,
  type BinaryFileTarget,
  createInterruptFlushService,
} from "../interrupt-flush.js";
import { createPromotionService } from "../promotion-service.js";

class MemoryFiles implements BinaryFileSource, BinaryFileTarget {
  readonly folders: string[] = [];
  readonly files = new Map<string, Uint8Array>();

  async readFileBinary(path: string): Promise<Uint8Array> {
    const bytes = this.files.get(path);
    if (!bytes) throw new Error(`file not found: ${path}`);
    return bytes;
  }

  async writeFileBinary(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, bytes);
  }

  async createFolder(path: string): Promise<void> {
    this.folders.push(path);
  }
}

describe("promotion service", () => {
  it("promotes a generated PNG with full provenance and lists by project", async () => {
    const objectStore = createInMemoryObjectStore();
    const results = createInMemoryResultRepository();
    const payload = Uint8Array.from([137, 80, 78, 71]);
    const sourcePath = "runs/root-1/output/qc/overlay.png";

    const promotion = createPromotionService({ objectStore, results });

    const promoted = await promotion.promoteArtifact({
      projectId: "wb-1",
      workId: "work-1",
      sourcePath,
      bytes: payload,
      provenance: {
        rootThreadId: "root-1",
        threadId: "thread-1",
        turnId: "turn-1",
        toolCallId: "call-1",
        agentSlug: "segmenter",
      },
    });

    expect(promoted.ok).toBe(true);
    if (!promoted.ok) return;

    expect(promoted.value).toMatchObject({
      sourcePath,
      resultsUri: "work://work-1/results/output/qc/overlay.png",
      mimeType: "image/png",
      sizeBytes: 4,
      provenance: {
        rootThreadId: "root-1",
        threadId: "thread-1",
        turnId: "turn-1",
        toolCallId: "call-1",
        agentSlug: "segmenter",
      },
    });

    const listed = await results.listByProject("wb-1");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.provenance).toEqual(promoted.value.provenance);
  });

  it("skips non-promotable paths via policy", async () => {
    const objectStore = createInMemoryObjectStore();
    const results = createInMemoryResultRepository();
    const promotion = createPromotionService({ objectStore, results });

    const result = await promotion.promoteArtifact({
      projectId: "wb-1",
      workId: "work-1",
      sourcePath: "runs/root-1/scratch.log",
      bytes: Uint8Array.from([1]),
      provenance: {
        rootThreadId: "root-1",
        threadId: "thread-1",
        turnId: "turn-1",
        toolCallId: null,
        agentSlug: "segmenter",
      },
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "policy_skip", message: expect.stringContaining("scratch.log") },
    });
    expect(await results.listByProject("wb-1")).toEqual([]);
  });
});

describe("interrupt flush and rehydrate", () => {
  it("flush → wipe files → rehydrate restores bytes-identical files", async () => {
    const objectStore = createInMemoryObjectStore();
    const results = createInMemoryResultRepository();
    const sourceFiles = new MemoryFiles();

    const pathA = "runs/root-1/qc/a.png";
    const pathB = "runs/root-1/labels.nii.gz";
    const bytesA = Uint8Array.from([1, 2, 3, 4]);
    const bytesB = Uint8Array.from([9, 9, 9]);
    await sourceFiles.writeFileBinary(pathA, bytesA);
    await sourceFiles.writeFileBinary(pathB, bytesB);

    const promotion = createPromotionService({ objectStore, results });
    const flushService = createInterruptFlushService({
      promotion,
      objectStore,
      getReadableFiles: async () => sourceFiles,
      getWritableFiles: async () => sourceFiles,
    });

    const flushed = await flushService.flushAtInterrupt({
      projectId: "wb-1",
      workId: "work-1",
      provenance: {
        rootThreadId: "root-1",
        threadId: "thread-1",
        turnId: "turn-1",
        toolCallId: null,
        agentSlug: "orchestrator",
      },
      sourcePaths: [pathA, pathB, "runs/root-1/notes.txt"],
    });

    expect(flushed.ok).toBe(true);
    if (!flushed.ok) return;
    expect(flushed.value.entries).toHaveLength(2);
    expect(JSON.parse(JSON.stringify(flushed.value))).toEqual(flushed.value);

    const freshFiles = new MemoryFiles();
    const rehydrateService = createInterruptFlushService({
      promotion,
      objectStore,
      getReadableFiles: async () => sourceFiles,
      getWritableFiles: async () => freshFiles,
    });
    const rehydrated = await rehydrateService.rehydrateFromManifest({ manifest: flushed.value });
    expect(rehydrated.ok).toBe(true);
    if (!rehydrated.ok) return;

    await expect(freshFiles.readFileBinary(pathA)).resolves.toEqual(bytesA);
    await expect(freshFiles.readFileBinary(pathB)).resolves.toEqual(bytesB);
  });
});
