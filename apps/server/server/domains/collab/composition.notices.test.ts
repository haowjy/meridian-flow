/** Safety-notice producer coverage for collab response finalization. */
import { describe, expect, it, vi } from "vitest";
import type { NoticePort } from "../notices/index.js";
import { createNoticeBackedUndoPort, recordLateSweepNotice } from "./composition.js";

describe("collab safety notices", () => {
  it("maps user undo producer events onto kind undo", async () => {
    const record = vi.fn<NoticePort["record"]>(async () => {});
    const port = createNoticeBackedUndoPort({
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
});
