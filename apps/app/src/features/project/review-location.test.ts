/** A draft-only document's tab retains the document's scheme. */
import { CONTEXT_URI_SCHEMES } from "@meridian/contracts/context-uri";
import { expect, it } from "vitest";
import { contextTabFromDraftGroup } from "./context/context-tab-from-draft";

it.each(CONTEXT_URI_SCHEMES)("keeps a %s review's scheme on its draft-only tab", (scheme) => {
  const target = {
    ownerKey: "work:work",
    documentId: "hero",
    itemKey: "draft",
    contextLocation: { scheme, path: "/characters/Hero" },
    draftOnly: true,
  };
  expect(contextTabFromDraftGroup(target)).toMatchObject({
    scheme,
    path: "/characters/Hero",
    reviews: { "work:work": { itemKey: "draft", tabInstanceToken: expect.any(String) } },
  });
});
