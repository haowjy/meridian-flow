/** Draft pull service conformance for live-to-work and work-to-thread cadence. */

import type { DocumentId } from "@meridian/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { DraftCoordinator } from "./draft-coordinator.js";
import { createDraftPullService } from "./draft-pulls.js";
import type { LiveDocumentCoordinator } from "./ports/live-document-coordinator.js";

const DOCUMENT_ID = "00000000-0000-4000-8000-000000000701" as DocumentId;

function docWithText(value: string): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  doc.getText("content").insert(0, value);
  return doc;
}

describe("DraftPullService", () => {
  it("keeps the debounce armed after a failed flush and retries the live snapshot", async () => {
    vi.useFakeTimers();
    try {
      const live = docWithText("pending writer edit");
      const draft = new Y.Doc({ gc: false });
      let fail = true;
      const service = createDraftPullService({
        outsideTransaction: (operation) => operation(),
        liveCoordinator: coordinatorFor(live),
        draftCoordinator: {
          pullFromDoc: async ({ upstream }: { upstream: Y.Doc }) => {
            if (fail) {
              fail = false;
              throw new Error("pull failed");
            }
            Y.applyUpdate(draft, Y.encodeStateAsUpdate(upstream));
            return "pulled";
          },
        } as unknown as DraftCoordinator,
        drafts: {
          listActiveWorkDraftIds: async () => ["work"],
          ensureThreadPeerDraft: async () => ({
            documentDraft: { draftId: "peer", upstreamDraftId: "work" },
          }),
        },
        debounceMs: 10,
        maxDebounceMs: 50,
      });
      service.scheduleLivePull(DOCUMENT_ID);
      await expect(service.flushLivePull(DOCUMENT_ID)).rejects.toThrow("pull failed");
      expect(vi.getTimerCount()).toBe(2);
      await vi.advanceTimersByTimeAsync(10);
      expect(draft.getText("content").toString()).toBe("pending writer edit");
      expect(vi.getTimerCount()).toBe(0);
      draft.destroy();
      live.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps newer-update timers armed when a queued pull fails after an older pull commits", async () => {
    vi.useFakeTimers();
    const live = docWithText("old");
    const draft = new Y.Doc({ gc: false });
    try {
      const captured = deferred();
      const commit = deferred();
      let pulls = 0;
      const service = createDraftPullService({
        outsideTransaction: (operation) => operation(),
        liveCoordinator: coordinatorFor(live),
        draftCoordinator: {
          pullFromDoc: async ({ upstream }: { upstream: Y.Doc }) => {
            if (++pulls === 2) throw new Error("queued pull failed");
            Y.applyUpdate(draft, Y.encodeStateAsUpdate(upstream));
            // The first pull has committed; it returns only once the newer update queued.
            if (pulls === 1) {
              captured.resolve();
              await commit.promise;
            }
            return "pulled";
          },
        } as unknown as DraftCoordinator,
        drafts: {
          listActiveWorkDraftIds: async () => ["work"],
          ensureThreadPeerDraft: async () => ({
            documentDraft: { draftId: "peer", upstreamDraftId: "work" },
          }),
        },
        diagnostics: { backgroundFailed: () => {} },
        debounceMs: 10,
        maxDebounceMs: 50,
      });
      const older = service.flushLivePull(DOCUMENT_ID);
      await captured.promise;
      live.getText("content").insert(3, " and newer");
      service.scheduleLivePull(DOCUMENT_ID);
      const queued = expect(service.flushLivePull(DOCUMENT_ID)).rejects.toThrow(
        "queued pull failed",
      );
      commit.resolve();
      await older;
      await queued;
      expect(draft.getText("content").toString()).toBe("old");
      expect(vi.getTimerCount()).toBe(2);
      await vi.advanceTimersByTimeAsync(10);
      expect(draft.getText("content").toString()).toBe("old and newer");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      live.destroy();
      draft.destroy();
      vi.useRealTimers();
    }
  });

  it("reports timer failures and rearms the maximum debounce for later updates", async () => {
    vi.useFakeTimers();
    try {
      const failed = vi.fn();
      let failures = 2;
      const service = createDraftPullService({
        outsideTransaction: (operation) => operation(),
        liveCoordinator: coordinatorFor(docWithText("writer edit")),
        draftCoordinator: {
          pullFromDoc: async () => {
            if (failures-- > 0) throw new Error("timer pull failed");
            return "pulled";
          },
        } as unknown as DraftCoordinator,
        drafts: {
          listActiveWorkDraftIds: async () => ["work"],
          ensureThreadPeerDraft: async () => ({
            documentDraft: { draftId: "peer", upstreamDraftId: "work" },
          }),
        },
        diagnostics: { backgroundFailed: failed },
        debounceMs: 10,
        maxDebounceMs: 50,
      });
      service.scheduleLivePull(DOCUMENT_ID);
      await vi.advanceTimersByTimeAsync(50);
      expect(failed).toHaveBeenCalledTimes(2);
      service.scheduleLivePull(DOCUMENT_ID);
      expect(vi.getTimerCount()).toBe(2);
      await vi.advanceTimersByTimeAsync(10);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
function coordinatorFor(doc: Y.Doc): Pick<LiveDocumentCoordinator, "withDocument"> {
  return {
    withDocument: async (_documentId, fn) => fn(doc),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
