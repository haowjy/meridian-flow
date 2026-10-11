// @vitest-environment jsdom
/** Committed recursive deletion must reach the same replica projection as a file receipt. */
import "fake-indexeddb/auto";
import { reserveResourceDocument } from "@meridian/resource-replica";
import Dexie from "dexie";
import { expect, it, vi } from "vitest";
import { createAccountDocumentSessionRuntime } from "@/core/editor/account-document-session-runtime";
import { projectResourceTab } from "@/features/project/context/context-tab-from-file";
import { AccountResourceReplica } from "./account-resource-replica";
import { IndexedDbResourceMetadata } from "./indexeddb-resource-metadata";

it("marks every known descendant terminal, including unacquired viewers, without a second delete", async () => {
  vi.stubGlobal("navigator", {
    locks: {
      request: async (_name: string, _options: unknown, run: (lock: unknown) => Promise<unknown>) =>
        run({}),
    },
  });
  const accountId = crypto.randomUUID();
  const runtime = createAccountDocumentSessionRuntime({ accountId });
  const replica = new AccountResourceReplica(accountId, runtime);
  const writer = new IndexedDbResourceMetadata(accountId, () => {});
  try {
    for (const documentId of ["one", "two", "survivor", "newer"]) {
      const write = reserveResourceDocument({
        projectId: "project",
        handle: documentId,
        documentId,
        databaseName: "unused",
        schema: "schema",
        intentId: `create-${documentId}`,
      });
      write.next.resource.content = { kind: "unacquired" };
      if (documentId !== "survivor") {
        // The catalog has already lost these server documents, with no local intentions
        // to keep them visible. Terminal intake must still find their exact identities.
        write.next.intents = [];
        write.next.resource.obligations = {};
        write.next.resource.lifecycle = {
          kind: "acknowledged",
          availabilityGeneration: documentId === "newer" ? "10" : "8",
        };
      }
      await writer.commitResource(write);
    }
    await replica.acceptCommittedDelete({
      projectId: "project",
      deletedDocumentIds: ["one", "two", "unknown", "newer"],
      generation: "9",
    });
    await replica.acceptCommittedDelete({
      projectId: "project",
      deletedDocumentIds: ["one", "two"],
      generation: "9",
    });
    const { records } = await replica.readProjection("project");
    for (const documentId of ["one", "two"]) {
      expect(
        projectResourceTab(
          "project",
          { kind: "new", documentId, name: "old", resourceHandle: documentId },
          records,
          [],
        ),
      ).toMatchObject({ kind: "terminal", generation: "9" });
    }
    expect(
      records.find(({ resource }) => resource.identity.documentId === "survivor")?.resource
        .lifecycle.kind,
    ).toBe("local");
    expect(
      records.find(({ resource }) => resource.identity.documentId === "newer")?.resource.lifecycle,
    ).toEqual({ kind: "acknowledged", availabilityGeneration: "10" });
  } finally {
    await replica.finishClose();
    await runtime.finishClose();
    await writer.finishClose();
    vi.unstubAllGlobals();
    await Dexie.delete(`meridian:resource-metadata:v3:${encodeURIComponent(accountId)}`);
  }
});
