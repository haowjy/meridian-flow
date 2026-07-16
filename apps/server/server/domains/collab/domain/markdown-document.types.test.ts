// Compile-time contracts for the full-document markdown write surfaces.
import { expectTypeOf, it } from "vitest";
import type { DocumentSeedOrigin, MarkdownDocumentStore } from "../index.js";

it("keeps agent and human writes out of raw full-document replacement", () => {
  expectTypeOf<Parameters<MarkdownDocumentStore["writeDocument"]>[0]>().not.toHaveProperty(
    "preserveIdentity",
  );
  expectTypeOf<Parameters<MarkdownDocumentStore["editDocument"]>[0]>().not.toHaveProperty(
    "preserveIdentity",
  );
  expectTypeOf<
    Parameters<MarkdownDocumentStore["seedFromMarkdown"]>[2]
  >().toEqualTypeOf<DocumentSeedOrigin>();
});
