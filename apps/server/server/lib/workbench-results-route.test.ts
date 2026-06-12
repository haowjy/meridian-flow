/**
 * Route-core tests for the Results rail surface:
 * - `handleListWorkbenchResultsRequest`: ownership gate + flat transport projection.
 * - `handleWorkbenchResultSignedUrlRequest`: ownership gate + object-store signing
 *   + 404 on unknown result IDs.
 *
 * Uses in-memory adapters from the workbench / promotion / storage domains.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryResultRepository } from "../domains/context/promotion/adapters/in-memory-result-repository.js";
import { createInMemoryObjectStore } from "../domains/storage/adapters/in-memory/in-memory-object-store.js";
import { createObjectStorageUrl } from "../domains/storage/object-storage-url.js";
import { createInMemoryWorkbenchRepository } from "../domains/workbenches/index.js";
import {
  handleListWorkbenchResultsRequest,
  handleWorkbenchResultSignedUrlRequest,
} from "./workbench-results-route.js";

describe("workbench results route core", () => {
  it("lists promoted artifacts for an owned workbench, newest first", async () => {
    const workbenchRepo = createInMemoryWorkbenchRepository();
    const results = createInMemoryResultRepository();
    await workbenchRepo.create({ id: "wb-1", userId: "user-1" });

    // Insert in arbitrary order; the route must return newest-first by
    // `createdAt`.
    const older = await results.create({
      workbenchId: "wb-1",
      sourcePath: "/work/results/older.png",
      resultsUri: "results://wb-1/older.png",
      storageUrl: createObjectStorageUrl("results/wb-1/older.png"),
      mimeType: "image/png",
      sizeBytes: 100,
      provenance: {
        rootThreadId: "thread-root",
        threadId: "thread-1",
        turnId: "turn-1",
        toolCallId: null,
        agentSlug: "main",
      },
    });
    // Force a clock gap so `createdAt` is strictly increasing.
    await new Promise((resolve) => setTimeout(resolve, 2));
    const newer = await results.create({
      workbenchId: "wb-1",
      sourcePath: "/work/results/newer.csv",
      resultsUri: "results://wb-1/newer.csv",
      storageUrl: createObjectStorageUrl("results/wb-1/newer.csv"),
      mimeType: "text/csv",
      sizeBytes: 200,
      provenance: {
        rootThreadId: "thread-root",
        threadId: "thread-2",
        turnId: "turn-2",
        toolCallId: "tool-call-1",
        agentSlug: "child-agent",
      },
    });

    const response = await handleListWorkbenchResultsRequest(
      { workbenchRepo, results },
      { workbenchId: "wb-1", userId: "user-1" },
    );

    expect(response.results.map((row) => row.id)).toEqual([newer.id, older.id]);
    expect(response.results[0]).toMatchObject({
      workspacePath: "/work/results/newer.csv",
      mimeType: "text/csv",
      sizeBytes: 200,
      threadId: "thread-2",
      turnId: "turn-2",
      toolCallId: "tool-call-1",
      agentSlug: "child-agent",
    });
    expect(response.results[1]).toMatchObject({
      agentSlug: "main",
      toolCallId: null,
    });
  });

  it("returns 404 on the list endpoint when caller doesn't own the workbench", async () => {
    const workbenchRepo = createInMemoryWorkbenchRepository();
    const results = createInMemoryResultRepository();
    await workbenchRepo.create({ id: "wb-1", userId: "owner" });

    await expect(
      handleListWorkbenchResultsRequest(
        { workbenchRepo, results },
        { workbenchId: "wb-1", userId: "intruder" },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("mints a signed URL for an owned workbench's result and surfaces it", async () => {
    const workbenchRepo = createInMemoryWorkbenchRepository();
    const results = createInMemoryResultRepository();
    const objectStore = createInMemoryObjectStore();
    await workbenchRepo.create({ id: "wb-1", userId: "user-1" });

    // Put bytes so the in-memory store has something to sign. The store's
    // `getSignedUrl` fabricates a `/memory-object-store/<key>` URL.
    const put = await objectStore.put(
      "results/wb-1/figure.png",
      new TextEncoder().encode("png-bytes"),
      "image/png",
    );
    if (!put.ok) throw new Error(`fixture put failed: ${put.error.message}`);

    const record = await results.create({
      workbenchId: "wb-1",
      sourcePath: "/work/results/figure.png",
      resultsUri: "results://wb-1/figure.png",
      storageUrl: put.value.storageUrl,
      mimeType: "image/png",
      sizeBytes: 9,
      provenance: {
        rootThreadId: "thread-root",
        threadId: "thread-1",
        turnId: "turn-1",
        toolCallId: null,
        agentSlug: "main",
      },
    });

    const response = await handleWorkbenchResultSignedUrlRequest(
      { workbenchRepo, results, objectStore },
      { workbenchId: "wb-1", resultId: record.id, userId: "user-1" },
    );

    expect(response.resultId).toBe(record.id);
    expect(response.mimeType).toBe("image/png");
    expect(response.sizeBytes).toBe(9);
    expect(response.signedUrl).toMatch(/memory-object-store/);
    expect(response.signedUrl).toContain(encodeURIComponent("results/wb-1/figure.png"));
  });

  it("404s the signed-URL request when the result ID does not belong to the workbench", async () => {
    const workbenchRepo = createInMemoryWorkbenchRepository();
    const results = createInMemoryResultRepository();
    const objectStore = createInMemoryObjectStore();
    await workbenchRepo.create({ id: "wb-1", userId: "user-1" });

    await expect(
      handleWorkbenchResultSignedUrlRequest(
        { workbenchRepo, results, objectStore },
        { workbenchId: "wb-1", resultId: "missing", userId: "user-1" },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects signed-URL minting when caller does not own the workbench", async () => {
    const workbenchRepo = createInMemoryWorkbenchRepository();
    const results = createInMemoryResultRepository();
    const objectStore = createInMemoryObjectStore();
    await workbenchRepo.create({ id: "wb-1", userId: "owner" });

    await expect(
      handleWorkbenchResultSignedUrlRequest(
        { workbenchRepo, results, objectStore },
        { workbenchId: "wb-1", resultId: "anything", userId: "intruder" },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
