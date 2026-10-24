/** Draft pull service conformance for live-to-Work rebase cadence.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Live-to-Work pull debounce and retry
 */

import type { DocumentId } from "@meridian/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { DraftCoordinator } from "./draft-coordinator.js";
import { createDraftPullService } from "./draft-pulls.js";

const DOCUMENT_ID = "00000000-0000-4000-8000-000000000701" as DocumentId;

function docWithText(value: string): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText(value)]);
  doc.getXmlFragment("prosemirror").insert(0, [paragraph]);
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
        liveJournal: journalFor(live),
        draftCoordinator: mockCoordinator(async ({ upstream }: { upstream: Y.Doc }) => {
          if (fail) {
            fail = false;
            throw new Error("pull failed");
          }
          Y.applyUpdate(draft, Y.encodeStateAsUpdate(upstream));
          return "pulled";
        }),
        drafts: {
          listActiveWorkDraftIds: async () => ["work"],
          ensureThreadPeerDraft: async () => ({
            documentDraft: { draftId: "peer", upstreamDraftId: "work" },
            workDraft: { draftId: "work", seed: null },
          }),
        },
        debounceMs: 10,
        maxDebounceMs: 50,
      });
      service.scheduleLivePull(DOCUMENT_ID);
      await expect(service.flushLivePull(DOCUMENT_ID)).rejects.toThrow("pull failed");
      await vi.advanceTimersByTimeAsync(10);
      expect(
        draft
          .getXmlFragment("prosemirror")
          .toArray()
          .map((p) =>
            (p as Y.XmlElement)
              .toArray()
              .map((t) => t.toString())
              .join(""),
          )
          .join(""),
      ).toBe("pending writer edit");
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
        liveJournal: journalFor(live),
        draftCoordinator: mockCoordinator(async ({ upstream }: { upstream: Y.Doc }) => {
          if (++pulls === 2) throw new Error("queued pull failed");
          Y.applyUpdate(draft, Y.encodeStateAsUpdate(upstream));
          // The first pull has committed; it returns only once the newer update queued.
          if (pulls === 1) {
            captured.resolve();
            await commit.promise;
          }
          return "pulled";
        }),
        drafts: {
          listActiveWorkDraftIds: async () => ["work"],
          ensureThreadPeerDraft: async () => ({
            documentDraft: { draftId: "peer", upstreamDraftId: "work" },
            workDraft: { draftId: "work", seed: null },
          }),
        },
        diagnostics: { backgroundFailed: () => {} },
        debounceMs: 10,
        maxDebounceMs: 50,
      });
      const older = service.flushLivePull(DOCUMENT_ID);
      await captured.promise;
      ((live.getXmlFragment("prosemirror").get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(
        3,
        " and newer",
      );
      service.scheduleLivePull(DOCUMENT_ID);
      const queued = expect(service.flushLivePull(DOCUMENT_ID)).rejects.toThrow(
        "queued pull failed",
      );
      commit.resolve();
      await older;
      await queued;
      expect(
        draft
          .getXmlFragment("prosemirror")
          .toArray()
          .map((p) =>
            (p as Y.XmlElement)
              .toArray()
              .map((t) => t.toString())
              .join(""),
          )
          .join(""),
      ).toBe("old");
      expect(vi.getTimerCount()).toBe(2);
      await vi.advanceTimersByTimeAsync(10);
      expect(
        draft
          .getXmlFragment("prosemirror")
          .toArray()
          .map((p) =>
            (p as Y.XmlElement)
              .toArray()
              .map((t) => t.toString())
              .join(""),
          )
          .join(""),
      ).toBe("old and newer");
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
        liveJournal: journalFor(docWithText("writer edit")),
        draftCoordinator: mockCoordinator(async () => {
          if (failures-- > 0) throw new Error("timer pull failed");
          return "pulled";
        }),
        drafts: {
          listActiveWorkDraftIds: async () => ["work"],
          ensureThreadPeerDraft: async () => ({
            documentDraft: { draftId: "peer", upstreamDraftId: "work" },
            workDraft: { draftId: "work", seed: null },
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
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function journalFor(doc: Y.Doc) {
  return { read: async () => ({ checkpoint: Y.encodeStateAsUpdate(doc), updates: [] }) };
}

function mockCoordinator(pull: (input: { upstream: Y.Doc }) => Promise<unknown>): DraftCoordinator {
  let committed = new Y.Doc({ gc: false });
  return {
    loadBase: async () => ({
      snapshot: { status: "active" },
      replica: { doc: new Y.Doc({ gc: false }) },
    }),
    prepareAppend: (
      _base: unknown,
      _rows: unknown,
      options: { authorServerRows: (doc: Y.Doc) => Promise<Uint8Array[]> },
    ) => ({
      async persist() {
        const doc = new Y.Doc({ gc: false });
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(committed));
        doc.clientID = 1;
        try {
          await options.authorServerRows(doc);
          await pull({ upstream: doc });
          committed.destroy();
          committed = new Y.Doc({ gc: false });
          Y.applyUpdate(committed, Y.encodeStateAsUpdate(doc));
        } finally {
          doc.destroy();
        }
      },
      transfer() {},
      dispose() {},
    }),
  } as unknown as DraftCoordinator;
}
