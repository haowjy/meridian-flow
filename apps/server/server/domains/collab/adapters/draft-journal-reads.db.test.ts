// A save's journal reads stay on the save's own connection (contract §2.3).
import type { DocumentId } from "@meridian/contracts/runtime";
import { afterAll, describe, expect, it } from "vitest";
import {
  ALPHA_ID,
  closeDatabase,
  runInDrizzleTransaction,
} from "../test-support/change-trail-postgres-harness.js";
import { createDrizzleDraftReplayJournalReads } from "./drizzle-draft-journal-reads.js";

const { createDb } = await import("@meridian/database");

describe("draft journal reads (Postgres)", () => {
  // One pooled connection: a read that leaves the held transaction can never be served.
  const db = createDb(process.env.DATABASE_URL ?? "", { max: 1 });
  afterAll(() => closeDatabase(db));

  it("attribution's concurrent-row read uses the save transaction's connection", async () => {
    const reads = createDrizzleDraftReplayJournalReads(db);
    const outcome = await runInDrizzleTransaction(db, () =>
      Promise.race([
        reads
          .listConcurrentJournalRows("00000000-0000-4000-8000-0000000008f1", {
            documentId: ALPHA_ID as DocumentId,
            after: 0,
            through: Number.MAX_SAFE_INTEGER,
          })
          .then(() => "served"),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("waiting for a connection"), 1500),
        ),
      ]),
    );
    expect(outcome).toBe("served");
  });
});
