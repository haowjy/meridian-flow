/** Review admission and draft-only tabs retain the document's scheme. */
import { CONTEXT_URI_SCHEMES } from "@meridian/contracts/context-uri";
import { expect, it } from "vitest";
import { contextTabFromDraftGroup } from "../context/context-tab-from-draft";
import { admissible } from "./editor-review-handoff";

it.each(CONTEXT_URI_SCHEMES)("admits a %s review in its matching document and Work", (scheme) => {
  const intent = {
    workId: "work",
    documentId: "hero",
    draftId: "draft",
    sequence: 1,
    contextLocation: { scheme, path: "/characters/Hero" },
    isNewDocument: true,
  };
  expect(contextTabFromDraftGroup(intent)).toMatchObject({
    scheme,
    path: "/characters/Hero",
    draftOnly: true,
    reviewWorkId: "work",
    reviewDraftId: "draft",
  });
  const host = { editorWorkId: "work", activeScheme: scheme, documentId: "hero" };
  expect(admissible(intent, host)).toBe(true);
  expect(admissible(intent, { ...host, documentId: "other" })).toBe(false);
  expect(admissible(intent, { ...host, editorWorkId: "other" })).toBe(false);
});
