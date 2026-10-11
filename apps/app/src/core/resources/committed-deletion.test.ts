// @vitest-environment jsdom
/** Committed recursive deletion must reach the same replica projection as a file receipt. */
import "fake-indexeddb/auto";
import { reserveResourceDocument } from "@meridian/resource-replica";
import Dexie from "dexie";
import { expect, it, vi } from "vitest";
import { createAccountDocumentSessionRuntime } from "@/core/editor/account-document-session-runtime";
import { projectResourceTab } from "@/features/project/context/context-tab-from-file";
import { threadRecentIdentityIndex } from "@/features/project/context/thread-recent-identity";
import { AccountResourceReplica } from "./account-resource-replica";
import { IndexedDbResourceMetadata } from "./indexeddb-resource-metadata";

it("marks every known descendant terminal, including unacquired viewers, without a second delete", async () => {
  let busy = true;
  vi.stubGlobal("navigator", {
    locks: {
      request: async (name: string, _options: unknown, run: (lock: unknown) => Promise<unknown>) =>
        run(busy && name.endsWith("/two") ? null : {}),
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
    // The server already committed: a busy descendant cannot fail the command.
    await expect(
      replica.acceptCommittedDelete({
        projectId: "project",
        deletedDocumentIds: ["one", "two", "unknown", "newer"],
        generation: "9",
      }),
    ).resolves.toBeUndefined();
    expect((await writer.readResource({ handle: "one" }))?.resource.lifecycle.kind).toBe(
      "terminal",
    );
    expect((await writer.readResource({ handle: "two" }))?.resource.lifecycle.kind).toBe(
      "acknowledged",
    );
    busy = false;
    // No second user command, connectivity change, or catalog refresh is needed.
    await vi.waitFor(async () => {
      expect((await writer.readResource({ handle: "two" }))?.resource.lifecycle.kind).toBe(
        "terminal",
      );
    });
    const snapshot = await replica.readProjection("project");
    const { records } = snapshot;
    const recentIdentities = threadRecentIdentityIndex("project", snapshot);
    expect(recentIdentities.get("one")).toBeNull();
    expect(recentIdentities.get("two")).toBeNull();
    expect(recentIdentities.has("not-loaded")).toBe(false);
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

it("retains busy evidence across account teardown without late writes from the closed owner", async () => {
  let busy = true;
  vi.stubGlobal("navigator", {
    locks: {
      request: async (_name: string, _options: unknown, run: (lock: unknown) => Promise<unknown>) =>
        run(busy ? null : {}),
    },
  });
  const accountId = crypto.randomUUID();
  const runtime = createAccountDocumentSessionRuntime({ accountId });
  const replica = new AccountResourceReplica(accountId, runtime);
  const writer = new IndexedDbResourceMetadata(accountId, () => {});
  let returning: AccountResourceReplica | undefined;
  let returningRuntime: ReturnType<typeof createAccountDocumentSessionRuntime> | undefined;
  try {
    const write = reserveResourceDocument({
      projectId: "project",
      handle: "held",
      documentId: "held",
      databaseName: "unused",
      schema: "schema",
      intentId: "create-held",
    });
    write.next.intents = [];
    write.next.resource.obligations = {};
    write.next.resource.content = { kind: "unacquired" };
    write.next.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: "8" };
    await writer.commitResource(write);
    await replica.acceptCommittedDelete({
      projectId: "project",
      deletedDocumentIds: ["held"],
      generation: "9",
    });
    await replica.finishClose();
    await runtime.finishClose();
    busy = false;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await writer.readResource({ handle: "held" }))?.resource.lifecycle.kind).toBe(
      "acknowledged",
    );
    expect(await writer.readCommittedDeletions()).toHaveLength(1);
    returningRuntime = createAccountDocumentSessionRuntime({ accountId });
    returning = new AccountResourceReplica(accountId, returningRuntime);
    returning.start();
    await vi.waitFor(async () => {
      expect((await writer.readResource({ handle: "held" }))?.resource.lifecycle.kind).toBe(
        "terminal",
      );
      expect(await writer.readCommittedDeletions()).toHaveLength(0);
    });
  } finally {
    await returning?.finishClose();
    await returningRuntime?.finishClose();
    await replica.finishClose();
    await runtime.finishClose();
    await writer.finishClose();
    vi.unstubAllGlobals();
    await Dexie.delete(`meridian:resource-metadata:v3:${encodeURIComponent(accountId)}`);
  }
});
