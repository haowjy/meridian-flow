/**
 * Route-core tests for the Results rail surface:
 * - `handleListProjectResultsRequest`: ownership gate + flat transport projection.
 * - `handleProjectResultSignedUrlRequest`: ownership gate + object-store signing
 *   + 404 on unknown result IDs.
 *
 * Uses in-memory adapters from the project / promotion / storage domains.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryResultRepository } from "../domains/context/promotion/adapters/in-memory-result-repository.js";
import { createInMemoryProjectRepository } from "../domains/projects/index.js";
import { createInMemoryObjectStore } from "../domains/storage/adapters/in-memory/in-memory-object-store.js";
import { createObjectStorageUrl } from "../domains/storage/object-storage-url.js";
import {
  handleListProjectResultsRequest,
  handleProjectResultSignedUrlRequest,
} from "./project-results-route.js";

describe("project results route core", () => {
  const workId = "work-1";

  it("lists promoted artifacts for an owned project, newest first", async () => {
    const projectRepo = createInMemoryProjectRepository();
    const results = createInMemoryResultRepository();
    await projectRepo.create({ id: "wb-1", userId: "user-1" });

    // Insert in arbitrary order; the route must return newest-first by
    // `createdAt`.
    const older = await results.create({
      projectId: "wb-1",
      sourcePath: "/work/results/older.png",
      resultsUri: `work://${workId}/results/older.png`,
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
      projectId: "wb-1",
      sourcePath: "/work/results/newer.csv",
      resultsUri: `work://${workId}/results/newer.csv`,
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

    const response = await handleListProjectResultsRequest(
      { projectRepo, results },
      { projectId: "wb-1", userId: "user-1" },
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

  it("returns 404 on the list endpoint when caller doesn't own the project", async () => {
    const projectRepo = createInMemoryProjectRepository();
    const results = createInMemoryResultRepository();
    await projectRepo.create({ id: "wb-1", userId: "owner" });

    await expect(
      handleListProjectResultsRequest(
        { projectRepo, results },
        { projectId: "wb-1", userId: "intruder" },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("mints a signed URL for an owned project's result and surfaces it", async () => {
    const projectRepo = createInMemoryProjectRepository();
    const results = createInMemoryResultRepository();
    const objectStore = createInMemoryObjectStore();
    await projectRepo.create({ id: "wb-1", userId: "user-1" });

    // Put bytes so the in-memory store has something to sign. The store's
    // `getSignedUrl` fabricates a `/memory-object-store/<key>` URL.
    const put = await objectStore.put(
      "results/wb-1/figure.png",
      new TextEncoder().encode("png-bytes"),
      "image/png",
    );
    if (!put.ok) throw new Error(`fixture put failed: ${put.error.message}`);

    const record = await results.create({
      projectId: "wb-1",
      sourcePath: "/work/results/figure.png",
      resultsUri: `work://${workId}/results/figure.png`,
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

    const response = await handleProjectResultSignedUrlRequest(
      { projectRepo, results, objectStore },
      { projectId: "wb-1", resultId: record.id, userId: "user-1" },
    );

    expect(response.resultId).toBe(record.id);
    expect(response.mimeType).toBe("image/png");
    expect(response.sizeBytes).toBe(9);
    expect(response.signedUrl).toMatch(/memory-object-store/);
    expect(response.signedUrl).toContain(encodeURIComponent("results/wb-1/figure.png"));
  });

  it("404s the signed-URL request when the result ID does not belong to the project", async () => {
    const projectRepo = createInMemoryProjectRepository();
    const results = createInMemoryResultRepository();
    const objectStore = createInMemoryObjectStore();
    await projectRepo.create({ id: "wb-1", userId: "user-1" });

    await expect(
      handleProjectResultSignedUrlRequest(
        { projectRepo, results, objectStore },
        { projectId: "wb-1", resultId: "missing", userId: "user-1" },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects signed-URL minting when caller does not own the project", async () => {
    const projectRepo = createInMemoryProjectRepository();
    const results = createInMemoryResultRepository();
    const objectStore = createInMemoryObjectStore();
    await projectRepo.create({ id: "wb-1", userId: "owner" });

    await expect(
      handleProjectResultSignedUrlRequest(
        { projectRepo, results, objectStore },
        { projectId: "wb-1", resultId: "anything", userId: "intruder" },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
