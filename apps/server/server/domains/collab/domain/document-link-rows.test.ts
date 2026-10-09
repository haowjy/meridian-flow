/** Address-index rules apply equally to text runs, images, and figures. */
import type { ProjectId } from "@meridian/contracts/runtime";
import { expect, it } from "vitest";
import { deriveDocumentLinkRows } from "./document-link-rows.js";

const project = "project" as ProjectId;
const personal = "personal" as ProjectId;
it.each([
  ["kb://base.md", "scratch://@arc/next.md", "scratch://@arc/next.md", project],
  ["kb://base.md", "user://preferences.md", "user://preferences.md", personal],
  ["kb://base.md", "scratch://next.md", null, null],
  ["user://base.md", "manuscript://next.md", null, null],
])("indexes %s → %s", (holderUri, href, targetKey, targetProjectId) => {
  expect(
    deriveDocumentLinkRows({
      occurrences: [{ href }, { href }],
      holderUri,
      holderProjectId: project,
      personalProjectId: personal,
    }),
  ).toEqual([{ href, targetProjectId, targetKey, occurrences: 2 }]);
});
it("skips external, asset, and malformed hrefs", () => {
  expect(
    deriveDocumentLinkRows({
      occurrences: ["https://example.com", "asset:123", "%ZZ"].map((href) => ({ href })),
      holderUri: "manuscript://base.md",
      holderProjectId: project,
      personalProjectId: personal,
    }),
  ).toEqual([]);
});
