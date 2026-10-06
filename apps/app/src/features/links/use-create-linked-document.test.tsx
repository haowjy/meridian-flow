/** What a link can create, and that Create commits locally without waiting on the server. */

import { act } from "react";
import { expect, it, vi } from "vitest";
import { linkAheadAddress } from "@/core/editor/links";
import { withReactRoot } from "@/test-support/react-dom-harness";
import {
  type CreateLinkedDocument,
  linkCreationTarget,
  useCreateLinkedDocument,
} from "./use-create-linked-document";

const resources = vi.hoisted(() => ({
  reserveDocument: vi.fn(async () => ({
    key: { handle: "resource" },
    content: { kind: "opened", handle: { documentId: "document", release() {} } },
  })),
  setLocation: vi.fn(async () => ({ isLatest: true })),
  deleteDocument: vi.fn(),
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
  // The `@` menu's link-ahead row from a Scratch note names the manuscript, not its own folder.
  expect(linkAheadAddress("scratch://@live/notes/a.md", "Ch 2")).toBe("manuscript://Ch 2.md");
});

it("creates a manuscript document from local commits alone, with no server call", async () => {
  let creation!: CreateLinkedDocument;
  function Probe() {
    creation = useCreateLinkedDocument("project");
    return null;
  }
  await withReactRoot(<Probe />, async () => {
    const target = linkCreationTarget("manuscript://notes/scene.md");
    if (!target) throw new Error("Missing target");
    let documentId: string | null = null;
    await act(async () => {
      documentId = await creation.create(target);
    });
    expect(documentId).toBe("document");
    expect(resources.setLocation).toHaveBeenCalledWith(
      "project",
      { handle: "resource" },
      { scheme: "manuscript", folderPath: "notes", name: "scene.md", workId: null },
    );
    expect(creation.failed).toBe(false);
  });
});

it("discards a reservation that never reached its address and reports the failure", async () => {
  let creation!: CreateLinkedDocument;
  function Probe() {
    creation = useCreateLinkedDocument("project");
    return null;
  }
  resources.setLocation.mockRejectedValueOnce(new Error("refused"));
  resources.deleteDocument.mockResolvedValue(undefined);
  await withReactRoot(<Probe />, async () => {
    const target = linkCreationTarget("manuscript://scene.md");
    if (!target) throw new Error("Missing target");
    let documentId: string | null = "unset";
    await act(async () => {
      documentId = await creation.create(target);
    });
    expect(documentId).toBeNull();
    expect(resources.deleteDocument).toHaveBeenCalledWith("project", { handle: "resource" });
    expect(creation.failed).toBe(true);
  });
});
