/** The Editor adapter admits a tab only for a document the Editor can show. */

import type { CatalogFileEntry } from "@meridian/contracts/protocol";
import { expect, it, vi } from "vitest";
import { ProjectDocumentNavigationAdapter } from "./open-project-document";

it("settles an Uploads background open without admitting an Editor tab", async () => {
  const document: CatalogFileEntry = {
    kind: "file",
    entryId: "upload",
    scope: { kind: "work", projectId: "project", workId: "work" },
    sourceId: "uploads",
    parentId: "uploads",
    name: "map.png",
    aliases: [],
    path: ["map.png"],
    uri: "uploads://@work/map.png",
    provisionalName: false,
    editable: false,
    disposition: "binary",
    fileType: "image",
    mimeType: "image/png",
  };
  const result = { kind: "not-editable" as const, document };
  const openTab = vi.fn(() => ({ kind: "ineligible" as const }));
  const adapter = new ProjectDocumentNavigationAdapter({
    opener: { open: async () => result },
    openTab,
    openRoute: null,
  });

  expect(await adapter.open("project", { documentId: "upload", disposition: "background" })).toBe(
    result,
  );
  expect(openTab).not.toHaveBeenCalled();
});
