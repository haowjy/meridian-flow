/** What a link can create, and that Create commits locally without waiting on the server. */

import { act } from "react";
import { expect, it, vi } from "vitest";
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
