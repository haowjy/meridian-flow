/** Review admission and draft-only tabs retain the document's scheme. */
import { CONTEXT_URI_SCHEMES } from "@meridian/contracts/context-uri";
import { expect, it } from "vitest";
import { contextTabFromDraftGroup } from "../context/context-tab-from-draft";
import { admissible, requestedReviewItemKey } from "./editor-review-handoff";

it.each(CONTEXT_URI_SCHEMES)("admits a %s review in its matching document and Work", (scheme) => {
  const intent = {
    workId: "work",
    documentId: "hero",
    itemKey: "draft",
    sequence: 1,
    contextLocation: { scheme, path: "/characters/Hero" },
    draftOnly: true,
  };
  expect(contextTabFromDraftGroup(intent)).toMatchObject({
    scheme,
    path: "/characters/Hero",
    reviews: { work: { itemKey: "draft", tabInstanceToken: expect.any(String) } },
  });
  const host = { editorWorkId: "work", activeScheme: scheme, documentId: "hero" };
  expect(admissible(intent, host)).toBe(true);
  expect(admissible(intent, { ...host, documentId: "other" })).toBe(false);
  expect(admissible(intent, { ...host, editorWorkId: "other" })).toBe(false);
});

it("requests a warm Editor before admission, retaining only admitted review after failure", () => {
  const intent = {
    workId: "work",
    documentId: "hero",
    itemKey: "draft",
    sequence: 1,
    contextLocation: { scheme: "kb" as const, path: "/Hero" },
  };
  const host = {
    container: "editor" as const,
    editorWorkId: "work",
    activeScheme: "kb",
    documentId: "hero",
  };
  const presented = {
    container: "editor" as const,
    documentId: "hero",
    scheme: "kb" as const,
    path: "/Hero",
    review: null,
    draftOnly: false,
  };
  expect(requestedReviewItemKey(host, { intent, presented, inlineReview: null })).toBe("draft");
  expect(requestedReviewItemKey(host, { intent: null, presented, inlineReview: null })).toBeNull();
  expect(requestedReviewItemKey(host, { intent: null, presented, inlineReview: intent })).toBe(
    "draft",
  );
  expect(
    requestedReviewItemKey(host, {
      intent: null,
      presented: { ...presented, container: "dock" },
      inlineReview: intent,
    }),
  ).toBeNull();
});
