/** Durable-cut replay returns an owned Y.Doc without a serialization round trip. */
import type { UpdateJournal } from "@meridian/agent-edit/integration";
import type { Database } from "@meridian/database";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createDrizzleDraftReviewLive } from "./drizzle-draft-review-live.js";

describe("live review cut", () => {
  it("captures journal bytes in the transaction and returns a replayed document after commit", async () => {
    let transactionOpen = false;
    const source = new Y.Doc({ gc: false });
    source.getText("chapter").insert(0, "Durable text");
    const tx = {
      execute: async () => [],
      select: () => ({
        from: () => ({
          where: async () => [{ authorityId: "head", generation: 1, nextAdmissionSequence: 2 }],
        }),
      }),
    };
    const db = {
      transaction: async (operation: (tx: unknown) => Promise<unknown>) => {
        transactionOpen = true;
        try {
          return await operation(tx);
        } finally {
          transactionOpen = false;
        }
      },
    } as unknown as Database;
    const journal = {
      read: async () => {
        expect(transactionOpen).toBe(true);
        return {
          get checkpoint() {
            expect(transactionOpen).toBe(false);
            return Y.encodeStateAsUpdate(source);
          },
          updates: [],
        };
      },
    } as unknown as UpdateJournal;
    const cut = await createDrizzleDraftReviewLive(db, journal)("document");
    expect(transactionOpen).toBe(false);
    expect(cut.revision).toBe("head:1:2");
    expect(cut.doc).toBeInstanceOf(Y.Doc);
    expect(cut.doc.getText("chapter").toString()).toBe("Durable text");
    cut.doc.destroy();
    source.destroy();
  });
});
