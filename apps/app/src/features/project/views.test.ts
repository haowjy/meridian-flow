/** Main's document identity proofs across every editable catalog scheme. */

import { describe, expect, it } from "vitest";
import type { TreeFile } from "@/core/project-tree/tree-view";
import { resolveMainDocument } from "./views";

const file: TreeFile = {
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
  const emptyTree = {
    tree: { findPath: () => null, findDocument: () => null } as never,
    isComplete: true,
    isError: false,
  };
  const route = (
    overrides: Partial<Parameters<typeof resolveMainDocument>[0]> = {},
  ): ReturnType<typeof resolveMainDocument> =>
    resolveMainDocument({
      enabled: true,
      scheme: "manuscript",
      path: "/new-chapter.md",
      workId: null,
      addressed: { document: draftTab, draftOnly: true },
      tree: emptyTree,
      ...overrides,
    });

  it("is reached only by the address that names its draft, never by a plain path", () => {
    expect(route()).toMatchObject({ document: { documentId: "document-draft" }, draftOnly: true });
    expect(route({ addressed: null }).document).toBeNull();
  });

  it("keeps a bound draft-only document when another document now holds its old path", () => {
    // Document A moved from /old.md to /new.md and B took /old.md before the URL repaired.
    const occupant = { ...file, documentId: "document-b", path: "/old.md" };
    const tree = {
      ...emptyTree,
      tree: {
        findPath: (path: string) => (path === occupant.path ? occupant : null),
        findDocument: (id: string) => (id === occupant.documentId ? occupant : null),
      } as never,
    };
    const moved = { ...draftTab, path: "/new.md", name: "new.md" };
    const resolved = route({
      path: "/old.md",
      boundDocumentId: "document-draft",
      addressed: { document: moved, draftOnly: true },
      tree,
    });
    expect(resolved.document).toMatchObject({ documentId: "document-draft" });
    // A bound document no source resolves is pending, never the occupant.
    expect(
      route({ path: "/old.md", boundDocumentId: "document-draft", addressed: null, tree }).document,
    ).toBeNull();
  });
});
