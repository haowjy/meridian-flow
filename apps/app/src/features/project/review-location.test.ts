/** A draft-only document's tab retains the document's scheme. */
import { CONTEXT_URI_SCHEMES } from "@meridian/contracts/context-uri";
import { expect, it } from "vitest";
import { openDocumentFromDraftGroup } from "./context/open-document-from-draft";

it.each(CONTEXT_URI_SCHEMES)("keeps a %s review's scheme on its draft-only tab", (scheme) => {
  const target = { documentId: "hero", contextLocation: { scheme, path: "/characters/Hero" } };
  expect(openDocumentFromDraftGroup(target)).toMatchObject({
    scheme,
    path: "/characters/Hero",
  });
});
