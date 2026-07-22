/** In-memory authority heads track the same admitted journal prefix as production. */

import type { DocumentId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createInMemoryCollabDomain } from "./composition.js";

describe("in-memory document authority heads", () => {
  it("advances admittedThrough after an admission", async () => {
    const documentId = "00000000-0000-4000-8000-000000000317" as DocumentId;
    const collab = createInMemoryCollabDomain();
    await collab.ensureDocument(documentId);

    const [initial] = await collab.ensureAndReadAuthorityHeads([documentId]);
    await collab.writeDocument({
      documentId,
      markdown: "writer content\n",
      origin: { type: "user", actorUserId: "00000000-0000-4000-8000-000000000318" },
    });
    const [advanced] = await collab.ensureAndReadAuthorityHeads([documentId]);

    expect(initial?.admittedThrough).toBe(0n);
    expect(advanced).toMatchObject({
      authorityId: initial?.authorityId,
      admittedThrough: 1n,
    });
  });
});
