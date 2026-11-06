/** Route-core coverage for the universal authority-prefix name reservation. */

import { describe, expect, it } from "vitest";
import { parseCreateContextEntryBody } from "../routes/api/projects/[projectId]/context/[scheme]/create.post.js";
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
    ["file nested", { type: "file", path: "Branches/@notes.md" }],
    ["folder nested", { type: "folder", path: "Act 1/@Branches" }],
  ])("rejects create for a %s", (_label, body) => {
    expectAuthorityReservation(() => parseCreateContextEntryBody(body));
  });

  it.each([
    [
      "destination name",
      {
        operationId: "12345678-1234-4234-8234-123456789abc",
        kind: "file",
        name: "@notes.md",
      },
    ],
    [
      "created destination folder",
      {
        operationId: "12345678-1234-4234-8234-123456789abc",
        kind: "file",
        destinationParent: {
          kind: "root",
          scheme: "manuscript",
          owner: { workId: null },
          createFolders: ["Branches", "@Revision"],
        },
      },
    ],
  ])("rejects move for a %s", (_label, body) => {
    expectAuthorityReservation(() => parseContextMove(body));
  });
});
