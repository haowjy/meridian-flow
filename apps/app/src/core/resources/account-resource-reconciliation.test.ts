// @vitest-environment jsdom
/** Account reconciliation continues without a mounted project/catalog consumer. */
import "fake-indexeddb/auto";
import { markResourceCreateEligible, reserveResourceDocument } from "@meridian/resource-replica";
import Dexie from "dexie";
import { expect, it, vi } from "vitest";
import { createAccountDocumentSessionRuntime } from "@/core/editor/account-document-session-runtime";
import { AccountResourceReplica } from "./account-resource-replica";
import { IndexedDbResourceMetadata } from "./indexeddb-resource-metadata";

vi.mock("@/client/api/projects-api", () => ({
  createUntitledContextDocument: async (
    _project: string,
    _scheme: string,
    request: { documentId: string },
  ) => ({
    status: "created",
    documentId: request.documentId,
    scheme: "unfiled",
    path: "/Untitled.md",
    name: "Untitled.md",
  }),
}));

it("reconciles a newly committed intent with no UI subscribers", async () => {
  const held = new Set<string>();
  vi.stubGlobal("navigator", {
    locks: {
      async request(name: string, _options: unknown, run: (lock: unknown) => Promise<unknown>) {
        if (held.has(name)) return run(null);
        held.add(name);
        try {
          return await run({ name });
        } finally {
          held.delete(name);
        }
      },
    },
  });
  const accountId = crypto.randomUUID();
  const runtime = createAccountDocumentSessionRuntime({ accountId });
  const replica = new AccountResourceReplica(accountId, runtime);
  const writer = new IndexedDbResourceMetadata(accountId, () => {});
  try {
    replica.start();
    // Wait for initial storage observation before committing from another owner.
    await replica.readProjection("project");
    const reserved = reserveResourceDocument({
      projectId: "project",
      handle: "resource",
      documentId: "document",
      databaseName: "unused-content",
      schema: "schema",
      intentId: "create",
    });
    if (reserved.next.resource.content.kind === "exact")
      delete reserved.next.resource.content.initialization;
    await writer.commitResource(reserved);
    const eligible = markResourceCreateEligible(reserved.next, Date.now());
    if (!eligible) throw new Error("Expected pending create eligibility");
    await writer.commitResource(eligible);
    await vi.waitFor(async () => {
      const record = await writer.readResource({ handle: "resource" });
      expect(record?.resource.lifecycle.kind).toBe("acknowledged");
    });
  } finally {
    await replica.finishClose();
    await runtime.finishClose();
    await writer.finishClose();
    await Dexie.delete(`meridian:resource-metadata:v3:${encodeURIComponent(accountId)}`);
    vi.unstubAllGlobals();
  }
});
