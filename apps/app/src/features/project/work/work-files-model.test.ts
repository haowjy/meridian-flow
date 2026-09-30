import { describe, expect, it } from "vitest";
import { compareTreePlaces, type TreePlace } from "./work-files-model";

describe("compareTreePlaces", () => {
  const order = (places: TreePlace[]) =>
    [...places].sort(compareTreePlaces).map((place) => place.path);

  it("orders like the sidebar tree: folders first, then names, open folders' files under them", () => {
    expect(
      order([
        { path: "/zebra.md", folder: false },
        { path: "/notes/b.md", folder: false },
        { path: "/arc.md", folder: false },
        { path: "/notes", folder: true },
        { path: "/notes/a.md", folder: false },
        { path: "/drafts", folder: true },
      ]),
    ).toEqual(["/drafts", "/notes", "/notes/a.md", "/notes/b.md", "/arc.md", "/zebra.md"]);
  });
});
