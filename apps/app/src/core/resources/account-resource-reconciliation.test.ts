// @vitest-environment jsdom
/** Account reconciliation continues without a mounted project/catalog consumer. */
import "fake-indexeddb/auto";
import { markResourceCreateEligible, reserveResourceDocument } from "@meridian/resource-replica";
import Dexie from "dexie";
import { expect, it, vi } from "vitest";
import { MeridianApiError } from "@/client/api/http-client";
import {
  accessibleResourceCatalogView,
  projectCatalogView,
} from "@/client/query/useContextCatalog";
import { createAccountDocumentSessionRuntime } from "@/core/editor/account-document-session-runtime";
import { AccountResourceReplica } from "./account-resource-replica";
import { IndexedDbResourceMetadata } from "./indexeddb-resource-metadata";

const api = vi.hoisted(() => ({ moveContextEntry: vi.fn(), deleteContextEntry: vi.fn() }));
vi.mock("@/client/api/projects-api", () => ({
  ...api,
  lookupProjectContextAvailability: async () => ({ resolutions: [] }),
  getContextOperationReceipt: async () => null,
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
  const stopHints = vi.fn();
  const subscribe = vi.fn(() => stopHints);
  const replica = new AccountResourceReplica(accountId, runtime, undefined, {
    subscribe,
    reportConnected: () => {},
    reportDisconnected: () => {},
  });
  const writer = new IndexedDbResourceMetadata(accountId, () => {});
  try {
    replica.start();
    expect(subscribe).toHaveBeenCalledTimes(1);
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
    expect(stopHints).toHaveBeenCalledTimes(1);
    await runtime.finishClose();
    await writer.finishClose();
    await Dexie.delete(`meridian:resource-metadata:v3:${encodeURIComponent(accountId)}`);
    vi.unstubAllGlobals();
  }
});

it("keeps prose typed after filing when first placement is refused, listed in Unfiled with its error", async () => {
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
  vi.stubGlobal("isSecureContext", true);
  const reportedErrors: unknown[] = [];
  vi.stubGlobal("reportError", (error: unknown) => reportedErrors.push(error));
  let refuse!: () => void;
  const pending = new Promise<void>((done) => {
    refuse = done;
  });
  api.moveContextEntry.mockImplementation(async () => {
    await pending;
    throw new MeridianApiError(
      { code: "work_archived", message: "Work archived", source: "system", retryable: false },
      403,
    );
  });
  api.deleteContextEntry.mockClear();
  const accountId = crypto.randomUUID();
  const runtime = createAccountDocumentSessionRuntime({ accountId });
  const replica = new AccountResourceReplica(accountId, runtime);
  const writer = new IndexedDbResourceMetadata(accountId, () => {});
  let databaseName: string | undefined;
  let release: (() => void) | undefined;
  try {
    replica.start();
    const reservation = await replica.reserveDocument("project");
    if (reservation.content.kind !== "opened") throw new Error("Missing local document");
    const content = reservation.content.handle;
    release = () => content.release();
    databaseName = content.session.persistenceName ?? undefined;
    await replica.setLocation("project", reservation.key, {
      scheme: "scratch",
      folderPath: "",
      name: "scene.md",
      workId: "work",
      workSlug: "serial",
    });
    // File first, type second, refuse third. The content owner is a real local Yjs session.
    content.session.document.getText("prose").insert(0, "The dragon survives.");
    await replica.markCreateEligible(reservation.key);
    refuse();
    await vi.waitFor(async () => {
      const record = await writer.readResource(reservation.key);
      expect(record?.intents.find((intent) => intent.desired.kind === "set-location")?.state).toBe(
        "needs-repair",
      );
    });
    const record = await writer.readResource(reservation.key);
    if (record?.resource.content.kind !== "exact") throw new Error("Missing content");
    databaseName = record.resource.content.databaseName;
    expect(record.resource.obligations.cleanup).toBeUndefined();
    expect(content.session.document.getText("prose").toString()).toBe("The dragon survives.");
    expect(api.deleteContextEntry).not.toHaveBeenCalled();
    expect(reportedErrors).toEqual([]);
    const catalog = projectCatalogView(
      "project",
      "unfiled",
      accessibleResourceCatalogView("project", { kind: "project", projectId: "project" }, record),
      [record],
    );
    expect(catalog.children(catalog.root.entryId)).toMatchObject([
      {
        kind: "file",
        name: "Untitled.md",
        provisionalName: false,
        namespaceFailure: "set-location",
        namespaceRepairName: "scene.md",
      },
    ]);
  } finally {
    release?.();
    await replica.finishClose();
    await runtime.finishClose();
    await writer.finishClose();
    await Dexie.delete(`meridian:resource-metadata:v3:${encodeURIComponent(accountId)}`);
    if (databaseName) await Dexie.delete(databaseName);
    await Dexie.delete(`meridian:document-session-authority:${encodeURIComponent(accountId)}`);
    vi.unstubAllGlobals();
  }
});
