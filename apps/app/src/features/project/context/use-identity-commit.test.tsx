/** Desired-identity planning is independent of whichever surface submitted it. */

import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ContextTab } from "@/client/stores";
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

describe("useIdentityCommit", () => {
  it("keeps the locked No Work row in the destination after an Editor identity rename", async () => {
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
          path: "/before.md",
          name: "before.md",
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
          name: "after.md",
        });
      });
      expect(committed).toHaveBeenCalledWith(
        "doc-1",
        expect.objectContaining({ routeWorkId: NO_WORK, path: "/after.md" }),
        { isLatest: true },
      );
    });
  });
});
