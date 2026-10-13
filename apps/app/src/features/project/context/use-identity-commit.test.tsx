/** Desired-identity planning is independent of whichever surface submitted it. */

import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { deriveIdentityCommitPlan, useIdentityCommit } from "./use-identity-commit";

const NO_WORK = "123e4567-e89b-42d3-a456-426614174000";
const resources = vi.hoisted(() => ({
  setLocation: vi.fn(async () => ({ isLatest: true })),
}));
vi.mock("@/client/query/useWorks", () => ({
  useWorks: () => ({ works: [], noWork: { id: "123e4567-e89b-42d3-a456-426614174000" } }),
}));
vi.mock("@/features/project/context/account-feature-context", () => ({
  useAccountResourceReplica: () => resources,
}));

describe("useIdentityCommit", () => {
  it.each([
    ["before", "after.md", "after"],
    ["config.toml", "settings.md", "settings"],
    ["config.toml", "settings.txt", "settings"],
    ["config.toml", "Notes.md", "Notes"],
  ])("transports %s to %s as typed, retaining No Work and canonical presentation", async (current, typed, canonical) => {
    let rename!: ReturnType<typeof useIdentityCommit>;
    const committed = vi.fn();
    function Probe() {
      rename = useIdentityCommit({
        projectId: "project",
        editorWorkId: NO_WORK,
        tab: {
          kind: "tracked",
          documentId: "doc-1",
          resourceHandle: "resource",
          scheme: "scratch",
          workId: NO_WORK,
          path: `/${current}`,
          name: current,
          editable: true,
          filetype: "markdown",
          schemaType: "document",
        },
        onCommitted: committed,
      });
      return null;
    }
    await withReactRoot(<Probe />, async () => {
      await act(async () => {
        await rename({
          destination: { scheme: "scratch", folderPath: "", workId: NO_WORK },
          name: typed,
        });
      });
      expect(resources.setLocation).toHaveBeenLastCalledWith(
        "project",
        { handle: "resource" },
        expect.objectContaining({ name: typed }),
      );
      expect(committed).toHaveBeenCalledWith(
        "doc-1",
        expect.objectContaining({ routeWorkId: NO_WORK, path: `/${canonical}`, name: canonical }),
        expect.objectContaining({
          isLatest: true,
          tab: expect.objectContaining({ documentId: "doc-1" }),
        }),
      );
    });
  });
});

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

  it("keeps a dotted name whole and a visible extension on a bare rename (D13)", () => {
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
