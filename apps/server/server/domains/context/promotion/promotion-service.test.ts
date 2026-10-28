/** Consolidated test contracts; each block retains its original fixture scope.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Generated results path and provenance shape
 */

import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import { describe as __mergedSuite, expect, it, vi } from "vitest";
import { testWorkHandle } from "../../../test-support/work-handle.js";
import { createInMemoryEventSink, createNoopEventSink } from "../../observability/index.js";
import { resolvedWorkAuthority } from "../../projects/domain/work-authority.js";
import { createInMemoryObjectStore } from "../../storage/index.js";
import {
  type createInMemoryResultRepository,
  InMemoryResultRepository,
} from "./adapters/in-memory-result-repository.js";
import type { ProjectResultRecord } from "./ports/result-repository.js";
import { createPromotionService } from "./promotion-service.js";

__mergedSuite("promotion-reconciliation.test.ts", () => {
  // Merged from apps/server/server/domains/context/promotion/promotion-reconciliation.test.ts.
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
    },
  };

  function harness(outcome: { kind: "definitely_not_committed" | "unknown"; error: string }) {
    const put = vi.fn(async () => ({
      ok: true as const,
      value: { storageUrl: "storage://result" },
    }));
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
      },
      eventSink: sink,
      workAuthorityResolver: {
        async byId(_projectId, workId) {
          return resolvedWorkAuthority({
            workId,
            workHandle: testWorkHandle("w1"),
          });
        },
        async byHandle() {
          return null;
        },
        async noWork() {
          return null;
        },
        async lockById() {
          return null;
        },
      },
    });
    return { service, put, remove, sink };
  }

  __mergedSuite("promotion terminal reconciliation", () => {
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
        results: { createOrConverge: vi.fn() as never },
        eventSink: test.sink,
        workAuthorityResolver: {
          async byId() {
            return null;
          },
          async byHandle() {
            return null;
          },
          async noWork() {
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
});

__mergedSuite("promotion-and-flush.test.ts", () => {
  // Merged from apps/server/server/domains/context/promotion/__tests__/promotion-and-flush.test.ts.
  const promotionDeps = (
    objectStore: ReturnType<typeof createInMemoryObjectStore>,
    results: ReturnType<typeof createInMemoryResultRepository>,
  ) => ({
    objectStore,
    results,
    eventSink: createNoopEventSink(),
    workAuthorityResolver: {
      async byId(_projectId: string, workId: string) {
        return workId === "work-1"
          ? resolvedWorkAuthority({
              workId,
              workHandle: testWorkHandle("w2"),
            })
          : null;
      },
      async byHandle() {
        return null;
      },
      async noWork() {
        return null;
      },
      async lockById() {
        return null;
      },
    },
  });

  __mergedSuite("promotion service", () => {
    it("promotes a generated PNG with full provenance", async () => {
      const objectStore = createInMemoryObjectStore();
      const rows: ProjectResultRecord[] = [];
      const results = new InMemoryResultRepository(rows);
      const payload = Uint8Array.from([137, 80, 78, 71]);
      const sourcePath = "runs/root-1/output/qc/overlay.png";
      const promotion = createPromotionService(promotionDeps(objectStore, results));
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
        },
      });
      expect(promoted.ok).toBe(true);
      if (!promoted.ok) return;
      expect(promoted.value).toMatchObject({
        sourcePath,
        resultsUri: "scratch://@w2/results/output/qc/overlay.png",
        mimeType: "image/png",
        sizeBytes: 4,
        provenance: {
          rootThreadId: "root-1",
          threadId: "thread-1",
          turnId: "turn-1",
          toolCallId: "call-1",
        },
      });
      expect(parseUnifiedContextUri(promoted.value.resultsUri)).toMatchObject({
        ok: true,
        value: { authority: { kind: "work", workHandle: "w2" } },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.provenance).toEqual(promoted.value.provenance);
    });
  });
});
