/** Desired-identity planning is independent of whichever surface submitted it. */

import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { useIdentityCommit } from "./use-identity-commit";

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
