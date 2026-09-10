/** Routed phone document identity proofs across every editable catalog scheme. */

import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import type { CatalogContextView, CatalogFile } from "@/client/query/context-catalog-projection";
import { mobileEditableDocumentId, resolveMobileDocumentRoute } from "./mobile-document-route";

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
  ] as const)("passes the normalized routed %s identity to host demand", (scheme, workId) => {
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
    expect(mobileEditableDocumentId(route)).toBe(file.documentId);
  });

  it("publishes no demand when the phone route has no document", () => {
    const route = resolveMobileDocumentRoute({
      enabled: true,
      scheme: "scratch",
      path: null,
      workId: "work-a",
      catalog: catalogWith(file),
      isError: false,
      isFetching: false,
    });

    expect(route.tab).toBeNull();
    expect(mobileEditableDocumentId(route)).toBeNull();
  });
});
