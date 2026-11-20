/** Draft pull service conformance for live-to-Work rebase cadence.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Live-to-Work push debounce and the joined-pull rerun
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
  paragraph.setAttribute("id", "p");
  paragraph.insert(0, [new Y.XmlText(value)]);
  doc.getXmlFragment("prosemirror").insert(0, [paragraph]);
  return doc;
}

const textOf = (doc: Y.Doc) =>
  doc
    .getXmlFragment("prosemirror")
    .toArray()
    .map((p) =>
      (p as Y.XmlElement)
        .toArray()
        .map((t) => t.toString())
        .join(""),
    )
    .join("");

describe("DraftPullService", () => {
  it("pushes a debounced Live commit to the drafts open then, and a failure waits for the next commit", async () => {
    vi.useFakeTimers();
    const live = docWithText("pending writer edit");
    const draft = new Y.Doc({ gc: false });
    try {
      let fail = true;
      const failed = vi.fn();
      const opened = vi.fn(async () => ["work"]);
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
        openDraftRooms: opened,
        diagnostics: { backgroundFailed: failed, merged: () => {} },
        debounceMs: 10,
        maxDebounceMs: 50,
      });
      service.liveCommitted(DOCUMENT_ID);
      service.liveCommitted(DOCUMENT_ID);
      expect(opened).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10);
      expect(opened).toHaveBeenCalledTimes(1);
      expect(failed).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(textOf(draft)).toBe("");
      service.liveCommitted(DOCUMENT_ID);
      await vi.advanceTimersByTimeAsync(10);
      expect(textOf(draft)).toBe("pending writer edit");
    } finally {
      draft.destroy();
      live.destroy();
      vi.useRealTimers();
    }
  });

  it("a caller joining a running pull waits for a rerun that reads Live after its call", async () => {
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
          ++pulls;
          Y.applyUpdate(draft, Y.encodeStateAsUpdate(upstream));
          // The first pull has committed; it returns only once the newer update queued.
          if (pulls === 1) {
            captured.resolve();
            await commit.promise;
          }
          return "pulled";
        }),
        openDraftRooms: async () => [],
      });
      const older = service.catchUpDraft("work");
      await captured.promise;
      ((live.getXmlFragment("prosemirror").get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(
        3,
        " and newer",
      );
      const joined = service.catchUpDraft("work");
      const again = service.catchUpDraft("work");
      commit.resolve();
      await older;
      await joined;
      await again;
      expect(pulls).toBe(2);
      expect(textOf(draft)).toBe("old and newer");
    } finally {
      live.destroy();
      draft.destroy();
    }
  });

  it("keeps catching up under continuous Live commits: the maximum debounce fires", async () => {
    vi.useFakeTimers();
    try {
      const opened = vi.fn(async () => []);
      const service = createDraftPullService({
        outsideTransaction: (operation) => operation(),
        liveJournal: journalFor(docWithText("writer edit")),
        draftCoordinator: mockCoordinator(async () => "pulled"),
        openDraftRooms: opened,
        debounceMs: 10,
        maxDebounceMs: 50,
      });
      for (let at = 0; at < 60; at += 5) {
        service.liveCommitted(DOCUMENT_ID);
        await vi.advanceTimersByTimeAsync(5);
      }
      expect(opened).toHaveBeenCalledTimes(1);
      service.cancelScheduledPulls();
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
      snapshot: { status: "active", documentId: DOCUMENT_ID },
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
