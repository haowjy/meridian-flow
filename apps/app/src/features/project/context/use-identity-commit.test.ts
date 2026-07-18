/** Desired-identity planning is independent of whichever surface submitted it. */

import { describe, expect, it } from "vitest";
import type { ContextTab } from "@/client/stores";
import { deriveIdentityCommitPlan } from "./use-identity-commit";

const provisional: ContextTab = {
  kind: "tracked",
  documentId: "doc-1",
  scheme: "scratch",
  path: "/Untitled.md",
  name: "Untitled.md",
  workId: "work-1",
  editable: true,
  filetype: "markdown",
  schemaType: "document",
  provisionalName: true,
};

const desired = {
  destination: { scheme: "scratch" as const, folderPath: "/", workId: "work-1" },
  name: "Untitled.md",
};

describe("deriveIdentityCommitPlan", () => {
  it("graduates an explicitly saved provisional identity even when every value is unchanged", () => {
    expect(deriveIdentityCommitPlan(provisional, desired, "work-1")).toEqual({
      kind: "commit",
      desired,
    });
  });

  it("does nothing for the same identity after graduation", () => {
    expect(
      deriveIdentityCommitPlan({ ...provisional, provisionalName: false }, desired, "work-1"),
    ).toEqual({ kind: "no-op" });
  });

  it("routes rename and move through one commit plan", () => {
    expect(
      deriveIdentityCommitPlan(provisional, { ...desired, name: "Opening.md" }, "work-1").kind,
    ).toBe("commit");
    expect(
      deriveIdentityCommitPlan(
        provisional,
        { destination: { scheme: "manuscript", folderPath: "/Act 1" }, name: "Opening.md" },
        "work-1",
      ).kind,
    ).toBe("commit");
  });
});
