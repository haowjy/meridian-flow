/** Routed phone document identity proofs across every editable catalog scheme. */

import { describe, expect, it } from "vitest";
import type { CatalogFile } from "@/client/query/context-catalog-projection";
import { resolveMobileDocumentRoute } from "./mobile-document-route";

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

  it("is never another Work's draft, and never a live tab", () => {
    expect(route({ workId: "work-b" }).tab).toBeNull();
    expect(route({ workspaceTabs: [{ ...draftTab, draftOnly: undefined }] }).tab).toBeNull();
  });

  it("keeps a bound draft-only document when another document now holds its old path", () => {
    // Document A moved from /old.md to /new.md and B took /old.md before the URL repaired.
    const occupant = { ...file, documentId: "document-b", path: "/old.md" };
    const catalog = {
      findPath: (path: string) => (path === occupant.path ? occupant : null),
      findDocument: (id: string) => (id === occupant.documentId ? occupant : null),
    } as never;
    const moved = { ...draftTab, path: "/new.md", name: "new.md" };
    const resolved = route({
      path: "/old.md",
      boundDocumentId: "document-draft",
      workspaceTabs: [moved],
      catalog,
    });
    expect(resolved.tab).toMatchObject({ documentId: "document-draft", draftOnly: true });
    // A bound document no source resolves is pending, never the occupant.
    expect(
      route({ path: "/old.md", boundDocumentId: "document-draft", workspaceTabs: [], catalog }).tab,
    ).toBeNull();
  });
});
