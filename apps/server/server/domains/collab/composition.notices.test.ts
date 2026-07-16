/** Safety-notice producer coverage for collab response finalization. */
import { describe, expect, it, vi } from "vitest";
import type { NoticePort } from "../notices/index.js";
import {
  createReversalNoticePort,
  recordAwarenessDegradedNotice,
  recordLateSweepNotice,
  recordNoticeAfterDurability,
} from "./composition.js";

describe("collab safety notices", () => {
  it("maps user undo producer events onto kind undo", async () => {
    const record = vi.fn<NoticePort["record"]>(async () => {});
    const port = createReversalNoticePort({
      notices: {
        record,
        async drainForModelContext() {
          return [];
        },
        async drainForWriter() {
          return [];
        },
        subscribeWriterVisible() {
          return () => {};
        },
      },
      documentUriResolver: async () => "manuscript://chapter-one.md",
    });

    await port.record({
      threadId: "thread-1",
      writeHandles: ["w1"],
      writeHandleTurns: [{ writeHandle: "w1", turnId: "turn-1" }],
      docId: "document-1",
      direction: "undo",
      sweptContent: false,
      beforeContentRef: null,
    });

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "undo",
        scope: { kind: "thread", threadId: "thread-1" },
        data: expect.objectContaining({ writeHandles: ["w1"], direction: "undo" }),
      }),
    );
  });

  it("records late sweeps with captured bodies and before-state reference", async () => {
    const record = vi.fn<NoticePort["record"]>(async () => {});
    await recordLateSweepNotice({
      notices: {
        record,
        async drainForModelContext() {
          return [];
        },
        async drainForWriter() {
          return [];
        },
        subscribeWriterVisible() {
          return () => {};
        },
      },
      resolveDocumentUri: async () => "manuscript://arc/chapter-one.md",
      threadId: "thread-1",
      documentId: "document-1",
      lateSweep: {
        affectedBlockHashes: ["hash-a"],
        capturedDeletedBodies: [{ hash: "hash-a", body: "Writer paragraph." }],
        sweptContent: true,
        beforeContentRef: 42,
      },
    });

    expect(record).toHaveBeenCalledWith({
      kind: "late_sweep",
      scope: { kind: "thread", threadId: "thread-1" },
      message: "Content was modified — View change",
      data: {
        documentId: "document-1",
        documentName: "chapter-one",
        uri: "manuscript://arc/chapter-one.md",
        affectedBlockHashes: ["hash-a"],
        capturedDeletedBodies: [{ hash: "hash-a", body: "Writer paragraph." }],
        beforeContentRef: 42,
      },
      writerVisible: true,
    });
  });

  it("records a model-only degraded-awareness notice for every committed document", async () => {
    const record = vi.fn<NoticePort["record"]>(async () => {});
    await recordAwarenessDegradedNotice({
      notices: {
        record,
        async drainForModelContext() {
          return [];
        },
        async drainForWriter() {
          return [];
        },
        subscribeWriterVisible() {
          return () => {};
        },
      },
      resolveDocumentUri: async (documentId) =>
        documentId === "document-1"
          ? "manuscript://arc/chapter-one.md"
          : "manuscript://arc/chapter-two.md",
      threadId: "thread-1",
      documentIds: ["document-1", "document-2"],
    });

    expect(record).toHaveBeenCalledWith({
      kind: "awareness_degraded",
      scope: { kind: "thread", threadId: "thread-1" },
      message:
        "Your changes are committed, but concurrent writer content could not be verified. Re-read to confirm current state.",
      data: {
        documentIds: ["document-1", "document-2"],
        documentNames: ["chapter-one", "chapter-two"],
      },
      writerVisible: false,
    });
  });

  it("does not turn a durable response into an error when notice recording fails", async () => {
    const recordDegraded = vi.fn(async () => {});
    await expect(
      recordNoticeAfterDurability(
        {
          notices: noticePort(vi.fn()),
          threadId: "thread-1",
          documentIds: ["document-1"],
          kind: "late_sweep",
          recordDegraded,
        },
        async () => {
          throw new Error("notice store unavailable");
        },
      ),
    ).resolves.toBeUndefined();
    expect(recordDegraded).toHaveBeenCalledOnce();
  });
});

function noticePort(record: NoticePort["record"]): NoticePort {
  return {
    record,
    async drainForModelContext() {
      return [];
    },
    async drainForWriter() {
      return [];
    },
    subscribeWriterVisible() {
      return () => {};
    },
  };
}
