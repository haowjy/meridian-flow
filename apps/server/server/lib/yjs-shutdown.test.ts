import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { drainYjsPersistence } from "./yjs-shutdown.js";

describe("drainYjsPersistence", () => {
  it("attempts each live checkpoint and drains queued writes when one checkpoint fails", async () => {
    const first = new Y.Doc();
    const second = new Y.Doc();
    const failure = new Error("checkpoint failed");
    const checkpoint = vi
      .fn<(documentId: string, document: Y.Doc) => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce();
    const drainPendingWrites = vi.fn().mockResolvedValue(undefined);

    await expect(
      drainYjsPersistence({
        documents: [
          ["live:first", first],
          ["branch:ignored", new Y.Doc()],
          ["live:second", second],
        ],
        parseLiveDocument: (roomName) =>
          roomName.startsWith("live:") ? roomName.slice("live:".length) : undefined,
        checkpoint,
        drainPendingWrites,
      }),
    ).rejects.toMatchObject({ errors: [failure] });

    expect(checkpoint).toHaveBeenCalledTimes(2);
    expect(drainPendingWrites).toHaveBeenCalledOnce();
    first.destroy();
    second.destroy();
  });

  it("reports pending-write failure after still trying every document", async () => {
    const checkpoint = vi.fn().mockResolvedValue(undefined);
    const failure = new Error("queue drain failed");

    await expect(
      drainYjsPersistence({
        documents: [["live:only", new Y.Doc()]],
        parseLiveDocument: () => "only",
        checkpoint,
        drainPendingWrites: () => Promise.reject(failure),
      }),
    ).rejects.toMatchObject({ errors: [failure] });

    expect(checkpoint).toHaveBeenCalledOnce();
  });
});
