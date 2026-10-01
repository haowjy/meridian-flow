import { describe, expect, it } from "vitest";
import { parseDurableTrailSeedV1 } from "./change-trail-persistence.js";

const documentId = "00000000-0000-4000-8000-000000000001";
const receiptId = "00000000-0000-4000-8000-000000000002";

describe("durable change-trail seed", () => {
  it("decodes its transactional notice using the closed model-notice union", () => {
    const seed = {
      documentId,
      documentTitle: "Chapter 1",
      receiptId,
      threadIds: [],
      journalOwners: [],
      changes: [],
      transactionalNotice: {
        kind: "awareness_degraded",
        scope: { kind: "thread", threadId: documentId },
        message: "Concurrent writer state was unavailable.",
        data: { documentIds: [documentId], documentNames: ["Chapter 1"] },
      },
    };
    expect(parseDurableTrailSeedV1(seed).transactionalNotice).toMatchObject({
      kind: "awareness_degraded",
      data: { documentIds: [documentId] },
    });
    expect(() =>
      parseDurableTrailSeedV1({
        ...seed,
        transactionalNotice: { ...seed.transactionalNotice, kind: "unlisted" },
      }),
    ).toThrow("Invalid model notice");
  });
});
