/** Promotion ordering and terminal compensation contracts. */

import { describe, expect, it, vi } from "vitest";
import { testWorkSlug } from "../../../test-support/work-slug.js";
import { createInMemoryEventSink } from "../../observability/index.js";
import { resolvedWorkAuthority } from "../../projects/domain/work-authority.js";
import { createPromotionService } from "./promotion-service.js";

const input = {
  projectId: "project-1",
  workId: "work-1",
  sourcePath: "runs/root-1/output.png",
  bytes: Uint8Array.from([1]),
  provenance: {
    rootThreadId: "root-1",
    threadId: "thread-1",
    turnId: "turn-1",
    toolCallId: null,
    agentSlug: "writer",
  },
};

function harness(outcome: { kind: "definitely_not_committed" | "unknown"; error: string }) {
  const put = vi.fn(async () => ({ ok: true as const, value: { storageUrl: "storage://result" } }));
  const remove = vi.fn(async () => ({ ok: true as const, value: undefined }));
  const sink = createInMemoryEventSink();
  const service = createPromotionService({
    objectStore: {
      put,
      delete: remove,
      get: vi.fn() as never,
      list: vi.fn() as never,
      getSignedUrl: vi.fn() as never,
    },
    results: {
      createOrConverge: vi.fn(async () => outcome),
      listByProject: vi.fn(async () => []),
    },
    eventSink: sink,
    workAuthorityResolver: {
      async byId(_projectId, workId) {
        return resolvedWorkAuthority({
          kind: "work",
          workId,
          workSlug: testWorkSlug("123e4567-e89b-12d3-a456-426614174000"),
        });
      },
      async bySlug() {
        return null;
      },
      async lockById() {
        return null;
      },
    },
  });
  return { service, put, remove, sink };
}

describe("promotion terminal reconciliation", () => {
  it("deletes bytes exactly once only after definite non-commit", async () => {
    const test = harness({ kind: "definitely_not_committed", error: "rolled back" });
    await expect(test.service.promoteArtifact(input)).resolves.toMatchObject({
      ok: false,
      error: { code: "repository_error" },
    });
    expect(test.put).toHaveBeenCalledOnce();
    expect(test.remove).toHaveBeenCalledOnce();
  });

  it("retains bytes and diagnoses an unknown commit outcome", async () => {
    const test = harness({ kind: "unknown", error: "commit uncertain" });
    await test.service.promoteArtifact(input);
    expect(test.remove).not.toHaveBeenCalled();
    expect(test.sink.events).toEqual([
      expect.objectContaining({ name: "reconciliation.unknown", level: "warn" }),
    ]);
  });

  it("performs zero puts when exact Work resolution is unavailable", async () => {
    const test = harness({ kind: "unknown", error: "unused" });
    test.service = createPromotionService({
      objectStore: {
        put: test.put,
        delete: test.remove,
        get: vi.fn() as never,
        list: vi.fn() as never,
        getSignedUrl: vi.fn() as never,
      },
      results: { createOrConverge: vi.fn() as never, listByProject: vi.fn(async () => []) },
      eventSink: test.sink,
      workAuthorityResolver: {
        async byId() {
          return null;
        },
        async bySlug() {
          return null;
        },
        async lockById() {
          return null;
        },
      },
    });
    await expect(test.service.promoteArtifact(input)).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(test.put).not.toHaveBeenCalled();
  });
});
