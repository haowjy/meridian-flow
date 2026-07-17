/** Request-boundary validation for the context move route. */

import { describe, expect, it } from "vitest";
import { parseMoveContextEntryBody } from "./move.post.js";

describe("parseMoveContextEntryBody", () => {
  it("accepts a cross-scheme promotion to the destination root", () => {
    expect(
      parseMoveContextEntryBody({
        path: "/Untitled 1.md",
        sourceWorkId: "work-1",
        destinationScheme: "manuscript",
        destinationFolderPath: "",
      }),
    ).toEqual({
      path: "/Untitled 1.md",
      sourceWorkId: "work-1",
      destinationScheme: "manuscript",
      destinationFolderPath: "",
    });
  });

  it.each([
    [{ path: "a.md", destinationScheme: "unknown", destinationFolderPath: "" }],
    [{ path: "a.md", destinationScheme: "manuscript" }],
    [{ path: "a.md", destinationScheme: "manuscript", destinationFolderPath: ".." }],
    [
      {
        path: "a.md",
        destinationScheme: "manuscript",
        destinationFolderPath: "",
        newName: "folder/a.md",
      },
    ],
  ])("rejects an invalid body: %o", (body) => {
    expect(() => parseMoveContextEntryBody(body)).toThrow();
  });
});
