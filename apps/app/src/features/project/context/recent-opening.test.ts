/** A new draft is a resource handle, never a made-up path. */
import { expect, it } from "vitest";
import { recentOpening } from "./recent-opening";

it("records a local draft by resource handle", () => {
  expect(
    recentOpening(
      "project",
      { kind: "new", documentId: "draft", name: "Untitled", resourceHandle: "resource" },
      "2026-09-22T12:00:00.000Z",
    ),
  ).toEqual({
    documentId: "draft",
    projectId: "project",
    name: "Untitled",
    openedAt: "2026-09-22T12:00:00.000Z",
    address: { kind: "local", resourceHandle: "resource" },
  });
});

it("does not record a tab that has no readable path", () => {
  expect(
    recentOpening(
      "project",
      {
        kind: "tracked",
        documentId: "draft",
        scheme: "unfiled",
        path: "",
        name: "Untitled",
        editable: true,
        filetype: "markdown",
        schemaType: "document",
      },
      "2026-09-22T12:00:00.000Z",
    ),
  ).toBeNull();
});
