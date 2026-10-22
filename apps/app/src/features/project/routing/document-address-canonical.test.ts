/** Hidden reviews repair canonical locators while retaining their selected Work and draft. */
import type { CatalogFileEntry } from "@meridian/contracts/protocol";
import { expect, it } from "vitest";
import { canonicalDocumentAddress, canonicalReviewTabPatch } from "./document-address-canonical";
import type { ProjectAddress } from "./project-address";

it("follows a reviewed identity through a rename or cross-source move", () => {
  const address = {
    projectId: "project",
    destination: { kind: "document", scheme: "kb", path: "Withern" },
    work: { kind: "id", id: "00000000-0000-4000-8000-000000000001" },
    itemKey: "draft",
  } as ProjectAddress;
  const document = {
    kind: "file",
    entryId: "hidden",
    sourceId: "source",
    parentId: "folder",
    observationVersion: "1",
    name: "Withern",
    aliases: [],
    provisionalName: false,
    editable: true,
    filetype: "markdown",
    schemaType: "document",
    uri: "unfiled://Moved/Withern",
    path: ["Moved", "Withern"],
    scope: { kind: "project", projectId: "project" },
  } as CatalogFileEntry;
  expect(
    canonicalDocumentAddress(
      address,
      document,
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ),
  ).toEqual({
    ...address,
    destination: { kind: "document", scheme: "unfiled", path: "Moved/Withern" },
  });
});

it("refreshes a hidden tab's stale label without changing its review identity", () => {
  const destination = { kind: "document" as const, scheme: "kb" as const, path: "Collision Note" };
  const expected = { scheme: "kb", path: "/Collision Note", name: "Collision Note" };
  expect(
    canonicalReviewTabPatch(
      { scheme: "user", path: "/Before", name: "Before" },
      destination,
      "Collision Note",
    ),
  ).toEqual(expected);
  expect(canonicalReviewTabPatch(expected, destination, "Collision Note")).toBeNull();
});
