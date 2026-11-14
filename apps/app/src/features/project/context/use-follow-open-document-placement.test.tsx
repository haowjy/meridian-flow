// @vitest-environment jsdom
/**
 * The route follows an open document's placement only while the selection is bound to it.
 *
 * Pins implementation decisions: `useProjectTrees` is mocked to place the document at a new path,
 * since building a list's replay adds nothing to these cases.
 */
import "fake-indexeddb/auto";

import { useLayoutEffect } from "react";
import { expect, it, vi } from "vitest";
import type { OpenDocument } from "@/client/stores";
import {
  AccountFeatureTestProvider,
  useOptionalPresentedDocuments,
} from "@/test-support/account-feature-provider";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { OpenContextRoute } from "../routing/ProjectNavigationContext";
import { useFollowOpenDocumentPlacement } from "./use-follow-open-document-placement";

const tab: OpenDocument = {
  kind: "tracked",
  documentId: "doc-a",
  scheme: "manuscript",
  path: "/old.md",
  name: "old.md",
  editable: true,
  filetype: "markdown",
  schemaType: "document",
};

vi.mock("@/client/query/useProjectTrees", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/client/query/useProjectTrees")>()),
  useProjectTrees: () => ({
    isComplete: true,
    isError: false,
    sources: [],
    tree: () => null,
    find: () => ({
      source: { id: "s", scheme: "manuscript", name: "Manuscript", owner: { kind: "project" } },
      file: {
        kind: "file",
        entryId: "doc-a",
        parentId: "s",
        documentId: "doc-a",
        name: "new.md",
        extension: "md",
        path: "/new.md",
        uri: "manuscript:///new.md",
        provisionalName: false,
        hasProperties: false,
        editable: true,
        filetype: "markdown",
        schemaType: "document",
      },
    }),
  }),
}));

async function follows(input: { path?: string; review?: boolean } = {}) {
  const open = vi.fn<OpenContextRoute>(async () => ({ kind: "applied" as const }));
  function Present() {
    const presented = useOptionalPresentedDocuments();
    useLayoutEffect(() => presented?.mount("main", "project", tab, "main"), [presented]);
    return null;
  }
  function Host() {
    useFollowOpenDocumentPlacement({
      projectId: "project",
      editorWorkId: "work-a",
      review: input.review ?? false,
      activeContextScheme: "manuscript",
      activeContextPath: input.path ?? "/old.md",
      onOpenContextTarget: open,
    });
    return null;
  }
  await withReactRoot(
    <AccountFeatureTestProvider accountId="follow-account">
      <Present />
      <Host />
    </AccountFeatureTestProvider>,
    async () => undefined,
  );
  return open;
}

it("takes the route to main's document's new placement", async () => {
  const open = await follows();
  expect(open).toHaveBeenCalledTimes(1);
  expect(open.mock.calls[0]?.[0]).toMatchObject({ path: "/new.md", documentId: "doc-a" });
});

it("leaves a route the writer pointed elsewhere where they put it", async () => {
  expect(await follows({ path: "/pasted.md" })).not.toHaveBeenCalled();
});

it("leaves a review address on its own path, which the live placement does not show", async () => {
  expect(await follows({ review: true })).not.toHaveBeenCalled();
});
