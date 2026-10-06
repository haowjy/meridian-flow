/** No Work link creation uses local admission, not a server acknowledgement. */

import type { CatalogFileEntry } from "@meridian/contracts/protocol";
import { act } from "react";
import { expect, it, vi } from "vitest";
import { ProjectDocumentNavigationAdapter } from "@/features/project/context/open-project-document";
import { useIdentityCommit } from "@/features/project/context/use-identity-commit";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { linkCreationTarget } from "./use-create-linked-document";

const resources = vi.hoisted(() => ({
  reserveDocument: vi.fn(async () => ({
    key: { handle: "resource" },
    content: { kind: "opened", handle: { documentId: "document", release() {} } },
  })),
  setLocation: vi.fn(
    async (
      _project: string,
      _key: { handle: string },
      _destination: import("@meridian/resource-replica").ResourceDestination,
    ) => ({ isLatest: true }),
  ),
  deleteDocument: vi.fn(),
}));
// A server response that never arrives: local creation must not depend on it.
vi.mock("@/client/api/projects-api", () => ({ createContextEntry: () => new Promise(() => {}) }));
vi.mock("@/client/query/useWorks", () => ({
  useWorks: () => ({ works: [], noWork: { id: "123e4567-e89b-42d3-a456-426614174000" } }),
}));
vi.mock("@/features/project/context/account-feature-context", () => ({
  useAccountResourceReplica: () => resources,
}));

it("plans Create for a manuscript address and none for Scratch, whatever its Work", () => {
  expect(linkCreationTarget("manuscript://notes/scene.md")).toEqual({
    scheme: "manuscript",
    folderPath: "notes",
    name: "scene.md",
  });
  // Scratch notes come from a Work's Files tab or the AI, never from a link.
  expect(linkCreationTarget("scratch://@live/scene.md")).toBeNull();
  expect(linkCreationTarget("scratch://@/scene.md")).toBeNull();
  expect(linkCreationTarget("scratch://scene.md")).toBeNull();
  expect(linkCreationTarget("uploads://@live/map.png")).toBeNull();
});

it("keeps the locked No Work row in the destination after an Editor identity rename", async () => {
  let rename!: ReturnType<typeof useIdentityCommit>;
  const committed = vi.fn();
  resources.setLocation.mockResolvedValue({ isLatest: true });
  function Probe() {
    rename = useIdentityCommit({
      projectId: "project",
      editorWorkId: "123e4567-e89b-42d3-a456-426614174000",
      tab: {
        kind: "tracked",
        documentId: "document",
        resourceHandle: "resource",
        scheme: "scratch",
        workId: "123e4567-e89b-42d3-a456-426614174000",
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
        destination: {
          scheme: "scratch",
          folderPath: "",
          workId: "123e4567-e89b-42d3-a456-426614174000",
        },
        name: "after.md",
      });
    });
    expect(committed).toHaveBeenCalledWith(
      "document",
      expect.objectContaining({
        routeWorkId: "123e4567-e89b-42d3-a456-426614174000",
        path: "/after.md",
      }),
      { isLatest: true },
    );
  });
});

it("settles an Uploads background open without admitting an Editor tab", async () => {
  const document: CatalogFileEntry = {
    kind: "file",
    entryId: "upload",
    scope: { kind: "work", projectId: "project", workId: "work" },
    sourceId: "uploads",
    parentId: "uploads",
    name: "map.png",
    aliases: [],
    path: ["map.png"],
    uri: "uploads://@work/map.png",
    provisionalName: false,
    editable: false,
    disposition: "binary",
    fileType: "image",
    mimeType: "image/png",
  };
  const result = { kind: "not-editable" as const, document };
  const openTab = vi.fn(() => ({ kind: "ineligible" as const }));
  const adapter = new ProjectDocumentNavigationAdapter({
    opener: { open: async () => result },
    openTab,
    openRoute: null,
  });

  expect(await adapter.open("project", { documentId: "upload", disposition: "background" })).toBe(
    result,
  );
  expect(openTab).not.toHaveBeenCalled();
});
