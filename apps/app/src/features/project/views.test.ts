/** Main's document identity proofs across every editable catalog scheme. */

import { describe, expect, it } from "vitest";
import type { CatalogFile } from "@/client/query/context-catalog-projection";
import { resolveMainDocument } from "./views";

const file: CatalogFile = {
  kind: "file",
  entryId: "document-routed",
  parentId: "folder",
  documentId: "document-routed",
  name: "routed.md",
  extension: "",
  path: "/notes/routed.md",
  uri: "scratch://project/work/notes/routed.md",
  provisionalName: false,
  hasProperties: false,
  editable: true,
  filetype: "markdown",
  schemaType: "document",
};

describe("main's draft-only review route", () => {
  const draftTab = {
    kind: "tracked",
    documentId: "document-draft",
    scheme: "manuscript",
    path: "/new-chapter.md",
    name: "new-chapter.md",
    editable: true,
    filetype: "markdown",
    schemaType: "document",
  } as const;
  const emptyCatalog = { findPath: () => null, findDocument: () => null } as never;
  const route = (
    overrides: Partial<Parameters<typeof resolveMainDocument>[0]> = {},
  ): ReturnType<typeof resolveMainDocument> =>
    resolveMainDocument({
      enabled: true,
      scheme: "manuscript",
      path: "/new-chapter.md",
      workId: null,
      addressed: { tab: draftTab, draftOnly: true },
      catalog: emptyCatalog,
      isError: false,
      isFetching: false,
      ...overrides,
    });

  it("is reached only by the address that names its draft, never by a plain path", () => {
    expect(route()).toMatchObject({ tab: { documentId: "document-draft" }, draftOnly: true });
    expect(route({ addressed: null }).tab).toBeNull();
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
      addressed: { tab: moved, draftOnly: true },
      catalog,
    });
    expect(resolved.tab).toMatchObject({ documentId: "document-draft" });
    // A bound document no source resolves is pending, never the occupant.
    expect(
      route({ path: "/old.md", boundDocumentId: "document-draft", addressed: null, catalog }).tab,
    ).toBeNull();
  });
});
