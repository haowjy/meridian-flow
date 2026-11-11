/** A draft-only document keeps its scheme when opened from its draft group. */
import { CONTEXT_URI_SCHEMES } from "@meridian/contracts/context-uri";
import { expect, it } from "vitest";
import { openDocumentFromDraftGroup } from "./context/open-document-from-draft";

it.each(CONTEXT_URI_SCHEMES)("keeps a %s review's scheme on its draft-only document", (scheme) => {
  const target = { documentId: "hero", contextLocation: { scheme, path: "/characters/Hero" } };
  expect(openDocumentFromDraftGroup(target)).toMatchObject({
    scheme,
    path: "/characters/Hero",
  });
});
