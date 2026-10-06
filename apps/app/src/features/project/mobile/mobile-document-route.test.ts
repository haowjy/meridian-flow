/** Routed phone document identity proofs across every editable catalog scheme. */

import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import type { CatalogContextView, CatalogFile } from "@/client/query/context-catalog-projection";
import { resolveMobileDocumentRoute } from "./mobile-document-route";

function catalogWith(file: CatalogFile): CatalogContextView {
  return {
    findPath: (path) => (path === file.path ? file : null),
  } as CatalogContextView;
}

const file: CatalogFile = {
  kind: "file",
  entryId: "document-routed",
  parentId: "folder",
  documentId: "document-routed",
  name: "routed.md",
  path: "/notes/routed.md",
  uri: "scratch://project/work/notes/routed.md",
  provisionalName: false,
  editable: true,
  filetype: "markdown",
  schemaType: "document",
};

describe("mobile document route composition", () => {
  it.each([
    ["scratch", "work-a"],
    ["kb", undefined],
    ["user", undefined],
  ] as const)("passes the normalized routed %s identity to the host", (scheme, workId) => {
    const route = resolveMobileDocumentRoute({
      enabled: true,
      scheme: scheme as ProjectContextTreeScheme,
      path: file.path,
      workId: "work-a",
      catalog: catalogWith({ ...file, uri: `${scheme}://routed.md` }),
      isError: false,
      isFetching: false,
    });

    expect(route.tab).toMatchObject({
      documentId: file.documentId,
      scheme,
      path: file.path,
      ...(workId ? { workId } : {}),
    });
  });
});

describe("phone draft-only review route", () => {
  const draftTab = {
    kind: "tracked",
    documentId: "document-draft",
    scheme: "manuscript",
    path: "/new-chapter.md",
    name: "new-chapter.md",
    editable: true,
    filetype: "markdown",
    schemaType: "document",
    draftOnly: true,
    reviewWorkId: "work-a",
    reviewDraftId: "draft-a",
  } as const;
  const emptyCatalog = { findPath: () => null, findDocument: () => null } as never;
  const route = (
    overrides: Partial<Parameters<typeof resolveMobileDocumentRoute>[0]> = {},
  ): ReturnType<typeof resolveMobileDocumentRoute> =>
    resolveMobileDocumentRoute({
      enabled: true,
      scheme: "manuscript",
      path: "/new-chapter.md",
      workId: "work-a",
      workspaceTabs: [draftTab],
      catalog: emptyCatalog,
      isError: false,
      isFetching: false,
      ...overrides,
    });

  it("resolves a pending new document, which the live catalog never lists, from its review tab", () => {
    expect(route().tab).toMatchObject({ documentId: "document-draft", draftOnly: true });
  });

  it("follows the bound document when its path has moved", () => {
    expect(route({ path: "/renamed.md", boundDocumentId: "document-draft" }).tab).toMatchObject({
      documentId: "document-draft",
    });
    expect(route({ path: "/renamed.md" }).tab).toBeNull();
  });

  it("is never another Work's draft, and never a live tab", () => {
    expect(route({ workId: "work-b" }).tab).toBeNull();
    expect(route({ workspaceTabs: [{ ...draftTab, draftOnly: undefined }] }).tab).toBeNull();
  });

  it("prefers the live document once the catalog lists it", () => {
    const live = { ...file, documentId: "document-draft", path: "/new-chapter.md" };
    const tab = route({
      catalog: {
        findPath: (path: string) => (path === live.path ? live : null),
        findDocument: () => null,
      } as never,
    }).tab;
    expect(tab).toMatchObject({ documentId: "document-draft" });
    expect(tab).not.toHaveProperty("draftOnly", true);
  });
});
