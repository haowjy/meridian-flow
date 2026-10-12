/** One production-composed PostgreSQL project per test, shared by the import DB suites. */
import { createHash, randomUUID } from "node:crypto";
import { Hocuspocus } from "@hocuspocus/server";
import type { ImportManifest } from "@meridian/contracts";
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contentDocumentPredicate,
  contextSources,
  documents,
  projects,
  users,
  works,
} from "@meridian/database/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeEach } from "vitest";
import { composeAppServices, createProductionAppPorts } from "../../../lib/compose.js";
import { runAfterDrizzleCommit } from "../../../shared/drizzle-transaction.js";
import { deleteDrizzleRows } from "../../../test-support/drizzle-reset.js";
import { createNoopEventSink } from "../../observability/index.js";
import type { ObjectStorePort } from "../../storage/index.js";
import { createProductionImportPorts } from "../index.js";

export const importDbEnabled = process.env.RUN_DB_TESTS === "1" && !!process.env.DATABASE_URL;

export function barrier() {
  let arrive!: () => void, release!: () => void;
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    arrived,
    release,
    async pause() {
      arrive();
      await released;
    },
  };
}
/**
 * Run `action` on the planner's path right after the first chunk that created notes
 * commits, independent of how many other transactions planning opens.
 */
export function afterFirstNoteChunk(
  deps: ReturnType<typeof createProductionImportPorts>,
  action: () => Promise<void>,
) {
  const create = deps.tree.create,
    transaction = deps.repository.transaction;
  let committed = false,
    fired = false;
  deps.tree.create = async (parent, nodes) => {
    await create(parent, nodes);
    if (nodes.some((node) => node.kind === "note"))
      runAfterDrizzleCommit(() => {
        committed = true;
      });
  };
  deps.repository.transaction = async (run) => {
    const result = await transaction(run);
    if (committed && !fired) {
      fired = true;
      await action();
    }
    return result;
  };
}
export function loose(files: Record<string, string | Uint8Array>): {
  manifest: ImportManifest;
  bytes: Uint8Array[];
} {
  const bytes = Object.values(files).map((value) =>
    typeof value === "string" ? Buffer.from(value) : value,
  );
  return {
    manifest: {
      importId: randomUUID(),
      destination: { folderUri: "kb://" },
      sort: false,
      roots: Object.keys(files).map((name, rootId) => ({ rootId, kind: "file", name })),
      folders: [],
      entries: bytes.map((value, entryId) => ({
        entryId,
        rootId: entryId,
        path: "",
        size: value.length,
        sha256: createHash("sha256").update(value).digest("hex"),
        sniff: Buffer.from(value.subarray(0, 512)).toString("base64"),
      })),
    },
    bytes,
  };
}
/**
 * Register per-test project setup and teardown on the calling suite. Accessors read
 * the current test's project, so call them inside tests, not at collection time.
 */
export function useImportDb() {
  const db = createDb(process.env.DATABASE_URL ?? "postgres://unused", { max: 8 });
  let app: ReturnType<typeof composeAppServices>,
    appPorts: Awaited<ReturnType<typeof createProductionAppPorts>>;
  let userId: string, projectId: string;
  let hocuspocus: Hocuspocus;
  const objects = new Map<string, Uint8Array>();
  const objectStore: ObjectStorePort = {
    async put(key, bytes) {
      objects.set(key, bytes);
      return { ok: true, value: { storageUrl: key } };
    },
    async get(key) {
      const bytes = objects.get(key);
      return bytes
        ? { ok: true, value: { bytes, mimeType: "application/octet-stream" } }
        : { ok: false, error: { code: "not_found", message: "Not found" } };
    },
    async list(prefix) {
      return {
        ok: true,
        value: {
          keys: [...objects.keys()]
            .filter((key) => key.startsWith(prefix))
            .map((key) => ({ key, sizeBytes: objects.get(key)?.length ?? 0 })),
        },
      };
    },
    async getSignedUrl(key) {
      return { ok: true, value: key };
    },
    async delete(key) {
      objects.delete(key);
      return { ok: true, value: undefined };
    },
  };
  async function setupRuntime() {
    appPorts = await createProductionAppPorts({
      db,
      eventSink: createNoopEventSink(),
      environment: { OPENAI_API_KEY: "sk-test-import" },
    });
    app = composeAppServices(appPorts);
    hocuspocus = new Hocuspocus({
      yDocOptions: { gc: false, gcFilter: () => true },
      onStoreDocument: ({ documentName, document }) =>
        app.documentSync.storeHocuspocusDocument(documentName, document),
    });
    app.documentSync.bindHocuspocus(hocuspocus);
  }
  beforeEach(async () => {
    await deleteDrizzleRows(db, [users]);
    objects.clear();
    userId = randomUUID();
    projectId = randomUUID();
    await db.insert(users).values(conformanceUserValues(userId, "import"));
    await db.insert(projects).values({ id: projectId, userId, name: "Import", slug: "import" });
    await db
      .insert(works)
      .values({ projectId, createdByUserId: userId, name: "No Work", isNoWork: true });
    await db.insert(contextSources).values(
      ["kb", "manuscript", "unfiled"].map((slug) => ({
        projectId,
        name: slug,
        slug,
        scope: "project" as const,
        isPrimary: slug === "manuscript",
      })),
    );
    await setupRuntime();
  });
  afterEach(async () => {
    await app?.shutdown();
    const rooms = [...hocuspocus.documents.values()];
    await Promise.all(
      rooms.map((room) => hocuspocus.debouncer.executeNow(`onStoreDocument-${room.name}`)),
    );
    await Promise.all(rooms.map((room) => room.saveMutex.waitForUnlock()));
    await Promise.all(rooms.map((room) => hocuspocus.unloadDocument(room)));
  }, 120_000);
  afterAll(async () => {
    await deleteDrizzleRows(db, [users]);
    await db.close();
  });
  function ports() {
    return createProductionImportPorts(
      {
        db,
        collab: app.documentSync,
        contextPorts: app.contextPorts,
        catalog: appPorts.contextCatalog,
        links: app.linkScopes,
        ahead: app.linkAheadRegistry,
        objects: objectStore,
        eventSink: appPorts.eventSink,
      },
      projectId,
      userId,
    );
  }
  const context = () => app.contextPorts.forProject(projectId, userId, new Map());
  async function projectDocuments() {
    const sources = await db
      .select({ id: contextSources.id })
      .from(contextSources)
      .where(eq(contextSources.projectId, projectId));
    return db
      .select()
      .from(documents)
      .where(
        and(
          inArray(
            documents.contextSourceId,
            sources.map((source) => source.id),
          ),
          isNull(documents.deletedAt),
          contentDocumentPredicate(),
        ),
      );
  }
  async function _ok<T>(result: Promise<{ ok: true; value: T } | { ok: false; error: unknown }>) {
    const value = await result;
    if (!value.ok) throw new Error(JSON.stringify(value.error));
    return value.value;
  }
  return {
    db,
    objects,
    objectStore,
    ports,
    context,
    projectDocuments,
    ok: _ok,
    current: () => ({ app, projectId, userId }),
  };
}
