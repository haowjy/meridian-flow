/** Revision-query batching, uncertainty and the no-open-response-scope invariant. */
import { expect, it, vi } from "vitest";
import { queryCompactionRevisions } from "./compaction-revisions.js";

const evidence = { documentId: "chapter", uri: "manuscript://chapter", revision: "old" };
const recorded = new Map([
  ["read", [evidence]],
  ["write", [evidence]],
]);
it("queries distinct documents once and marks every failed lookup unknown", async () => {
  const current = vi.fn(async () => {
    throw new Error("authority unavailable");
  });
  const result = await queryCompactionRevisions({
    threadId: "thread",
    recorded,
    revisions: { current },
    assertNoResponseScope: () => {},
  });
  expect(current.mock.calls).toEqual([[{ threadId: "thread", documentIds: ["chapter"] }]]);
  expect(result).toEqual(new Map([["chapter", null]]));
});
it("throws an open response scope invariant instead of querying or treating it as unknown", async () => {
  const current = vi.fn(async () => new Map());
  await expect(
    queryCompactionRevisions({
      threadId: "thread",
      recorded,
      revisions: { current },
      assertNoResponseScope: () => {
        throw new Error("Compaction revision query requires no open response scope");
      },
    }),
  ).rejects.toThrow("no open response scope");
  expect(current).not.toHaveBeenCalled();
});
