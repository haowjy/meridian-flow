/** Desired-identity planning is independent of whichever surface submitted it. */

import { describe, expect, it } from "vitest";
import { deriveIdentityCommitPlan } from "./use-identity-commit";

describe("deriveIdentityCommitPlan", () => {
  const tabNamed = (name: string, filetype: "markdown" | "text" = "markdown") =>
    ({
      kind: "tracked",
      documentId: "doc-1",
      scheme: "manuscript",
      path: `/${name}`,
      name,
      editable: true,
      filetype,
      schemaType: "document",
    }) as const;
  const destination = { scheme: "manuscript", folderPath: "/", workId: undefined } as const;

  it("treats the stored name typed with a prose suffix as no change", () => {
    for (const typed of ["Chapter 13", "Chapter 13.md", "Chapter 13.txt", " Chapter 13 "]) {
      expect(
        deriveIdentityCommitPlan(tabNamed("Chapter 13"), { destination, name: typed }, null),
      ).toEqual({ kind: "no-op" });
    }
  });

  it("commits the stored name, not the typed one", () => {
    const plan = deriveIdentityCommitPlan(
      tabNamed("Chapter 13"),
      { destination, name: "Chapter 14.md" },
      null,
    );
    expect(plan).toMatchObject({ kind: "commit", desired: { name: "Chapter 14" } });
  });

  it("keeps a dotted name whole and a visible extension on a bare rename", () => {
    expect(
      deriveIdentityCommitPlan(tabNamed("Chapter 13"), { destination, name: "Vol. 2" }, null),
    ).toMatchObject({ kind: "commit", desired: { name: "Vol. 2" } });
    expect(
      deriveIdentityCommitPlan(
        tabNamed("config.toml", "text"),
        { destination, name: "settings" },
        null,
      ),
    ).toMatchObject({ kind: "commit", desired: { name: "settings.toml" } });
  });
});
