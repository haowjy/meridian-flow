/** Route-core coverage for the universal authority-prefix name reservation. */

import { describe, expect, it } from "vitest";
import { parseCreateContextEntryBody } from "../routes/api/projects/[projectId]/context/[scheme]/create.post.js";
import { parseRenameContextEntryBody } from "../routes/api/projects/[projectId]/context/[scheme]/rename.post.js";
import { parseContextMove } from "./context-move-route.js";

function expectAuthorityReservation(parse: () => unknown) {
  expect(parse).toThrowError(
    expect.objectContaining({
      status: 400,
      message: expect.stringContaining("reserved for authority qualifiers"),
      data: expect.objectContaining({ reason: "name/reserved-authority-qualifier" }),
    }),
  );
}

describe("context entry authority-prefix guard", () => {
  it.each([
    ["file at root", { type: "file", path: "@notes.md" }],
    ["file nested", { type: "file", path: "Drafts/@notes.md" }],
    ["folder at root", { type: "folder", path: "@Drafts" }],
    ["folder nested", { type: "folder", path: "Act 1/@Drafts" }],
  ])("rejects create for a %s", (_label, body) => {
    expectAuthorityReservation(() => parseCreateContextEntryBody(body));
  });

  it.each([
    ["root entry", { path: "notes.md", newName: "@notes.md" }],
    ["nested entry", { path: "Drafts/notes.md", newName: "@notes.md" }],
  ])("rejects rename for a %s", (_label, body) => {
    expectAuthorityReservation(() => parseRenameContextEntryBody(body));
  });

  it.each([
    [
      "root destination name",
      {
        path: "notes.md",
        destinationScheme: "manuscript",
        destinationFolderPath: "",
        newName: "@notes.md",
      },
    ],
    [
      "nested destination folder",
      {
        path: "notes.md",
        destinationScheme: "manuscript",
        destinationFolderPath: "Drafts/@Revision",
      },
    ],
  ])("rejects move for a %s", (_label, body) => {
    expectAuthorityReservation(() => parseContextMove({ sourceScheme: "manuscript", body }));
  });

  it("allows interior at signs through the shared route choke", () => {
    expect(parseCreateContextEntryBody({ type: "file", path: "Drafts/notes@revision.md" })).toEqual(
      { type: "file", path: "Drafts/notes@revision.md", content: undefined },
    );
    expect(
      parseRenameContextEntryBody({ path: "Drafts/notes.md", newName: "notes@revision.md" }),
    ).toEqual({ path: "Drafts/notes.md", newName: "notes@revision.md" });
  });
});
