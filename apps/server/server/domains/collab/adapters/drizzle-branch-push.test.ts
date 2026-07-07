import { describe, expect, it } from "vitest";
import { sortPushesByDocumentId } from "./drizzle-branch-push.js";

describe("sortPushesByDocumentId", () => {
  it("orders pushes by documentId so advisory locks match appendBatch", () => {
    const pushes = sortPushesByDocumentId([
      { branch: { documentId: "doc-z" }, idempotencyKey: "z" },
      { branch: { documentId: "doc-a" }, idempotencyKey: "a" },
      { branch: { documentId: "doc-m" }, idempotencyKey: "m" },
    ]);

    expect(pushes.map((push) => push.branch.documentId)).toEqual(["doc-a", "doc-m", "doc-z"]);
  });
});
