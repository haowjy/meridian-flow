/** Unknown revision evidence is already stale and must never poison valid revision reads. */
import { expect, it } from "vitest";
import { queryCompactionRevisions } from "./compaction-revisions.js";

it("does not resolve known-null edit records and preserves a current document revision", async () => {
  const current = await queryCompactionRevisions({
    threadId: "thread" as never,
    assertNoResponseScope() {},
    recorded: new Map([
      [
        "history",
        [
          {
            documentId: "manuscript://discarded.md",
            uri: "manuscript://discarded.md",
            revision: null,
          },
        ],
      ],
      [
        "read",
        [
          {
            documentId: "11111111-1111-4111-8111-111111111111",
            uri: "manuscript://current.md",
            revision: "v1",
          },
        ],
      ],
    ]),
    revisions: {
      async current({ documentIds }) {
        if (documentIds.some((id) => id.includes("://"))) throw new Error("Not a document id");
        return new Map(documentIds.map((id) => [id, "v1"]));
      },
    },
  });
  expect(current.get("11111111-1111-4111-8111-111111111111")).toBe("v1");
});
