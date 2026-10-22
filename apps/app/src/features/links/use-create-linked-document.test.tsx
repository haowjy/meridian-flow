/** What a link can create, and that Create commits locally without waiting on the server. */

import type { ParentRef } from "@meridian/resource-replica";
import { act } from "react";
import { expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import {
  type CreateLinkedDocument,
  linkCreationTarget,
  useCreateLinkedDocument,
} from "./use-create-linked-document";

const createFolder = vi.hoisted(() => vi.fn());
vi.mock("@/client/api/projects-api", () => ({ createContextEntry: createFolder }));
const resources = vi.hoisted(() => ({
  findParentAtLocation: vi.fn(
    async (): Promise<ParentRef | null> => ({
      kind: "root",
      scheme: "manuscript",
      owner: { workId: null },
    }),
  ),
  reserveDocument: vi.fn(async () => ({
    key: { handle: "resource" },
    content: { kind: "opened", handle: { documentId: "document", release() {} } },
  })),
}));
vi.mock("@/features/project/context/account-feature-context", () => ({
  useAccountResourceReplica: () => resources,
}));

it("reports a failed reservation", async () => {
  let creation!: CreateLinkedDocument;
  function Probe() {
    creation = useCreateLinkedDocument("project");
    return null;
  }
  resources.reserveDocument.mockRejectedValueOnce(new Error("refused"));
  await withReactRoot(<Probe />, async () => {
    const target = linkCreationTarget("manuscript://scene.md");
    if (!target) throw new Error("Missing target");
    let documentId: string | null = "unset";
    await act(async () => {
      documentId = await creation.create(target);
    });
    expect(documentId).toBeNull();
    expect(creation.failed).toBe(true);
  });
});

it("captures an existing nested home without contacting the server before opening", async () => {
  let creation!: CreateLinkedDocument;
  function Probe() {
    creation = useCreateLinkedDocument("project");
    return null;
  }
  resources.findParentAtLocation.mockResolvedValueOnce({
    kind: "folder",
    folderId: "picked-folder",
  });
  const target = linkCreationTarget("manuscript://Act/scene.md");
  if (!target) throw new Error("Missing target");
  createFolder.mockClear();
  resources.reserveDocument.mockClear();
  await withReactRoot(<Probe />, async () => {
    let id: string | null = null;
    await act(async () => {
      id = await creation.create(target);
    });
    expect(id).toBe("document");
    expect(createFolder).not.toHaveBeenCalled();
    // The destination rides the create, so a branch's document at this name is joined.
    expect(resources.reserveDocument).toHaveBeenCalledWith("project", "", {
      parent: { kind: "folder", folderId: "picked-folder" },
      name: "scene",
    });
  });
});

it("opens a missing-folder link from local persistence before any network completes", async () => {
  let creation!: CreateLinkedDocument;
  function Probe() {
    creation = useCreateLinkedDocument("project");
    return null;
  }
  resources.findParentAtLocation
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ kind: "folder", folderId: "anchor" });
  createFolder.mockClear();
  createFolder.mockImplementation(() => new Promise(() => {}));
  resources.reserveDocument.mockClear();
  await withReactRoot(<Probe />, async () => {
    const target = linkCreationTarget("manuscript://Act/New Arc/Part 1/Chapter 1");
    if (!target) throw new Error("Missing target");
    let id: string | null = null;
    await act(async () => {
      id = await Promise.race([
        creation.create(target),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
      ]);
    });
    expect(id).toBe("document");
    expect(createFolder).not.toHaveBeenCalled();
    expect(resources.reserveDocument).toHaveBeenCalledWith("project", "", {
      parent: { kind: "folder", folderId: "anchor" },
      createFolders: ["New Arc", "Part 1"],
      name: "Chapter 1",
    });
  });
});
