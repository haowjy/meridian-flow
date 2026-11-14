/** An import with a DOCX that holds an image survives interrupted reveals, against real Postgres.
 *
 * Protects:
 * - A pass interrupted after its batches wrote their texts resumes without writing a text twice,
 *   including the image folder no import entry stands for, and without a document existing
 *   before the reveal: the texts wait in the journal under the ids the creates will name.
 * - Retry revives an import that used up its tries.
 * - A failed pass is not reclaimed at once.
 * - After reveal, the Markdown document and the image are live and the document has block rows.
 * - Every node the reveal makes has a rank, so a drag relative to one places.
 * - A stopped import's waiting texts are deleted by the sweep, with its objects.
 */

import { randomUUID } from "node:crypto";
import type { ImportSelection } from "@meridian/contracts";
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  documentBlocks,
  documents,
  documentYjsHeads,
  imports,
  projects,
  treeNodes,
  users,
} from "@meridian/database/schema";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { composeAppServices, createProductionAppPorts } from "../../lib/compose.js";
import { deleteDrizzleRows } from "../../test-support/drizzle-reset.js";
import { treeSeeder } from "../../test-support/tree-seed.js";
import {
  createDrizzleContextImportRead,
  createDrizzleContextImportReveal,
  provisionProjectSources,
} from "../context/index.js";
import { createNoopEventSink } from "../observability/index.js";
import { processDetachedWork } from "../runtime/detached-work.js";
import { createInMemoryObjectStore } from "../storage/index.js";
import { createDrizzleImportRepository } from "./adapters/drizzle-import-repository.js";
import { createDrizzleOrganizeQueue } from "./adapters/drizzle-organize-queue.js";
import { sweepImportObjects } from "./domain/object-sweep.js";
import { createImportOrganizer } from "./domain/organize/organizer.js";
import { createImportAdmission } from "./domain/receive-admission.js";
import { createImportUploadService } from "./domain/upload-service.js";

const enabled = process.env.RUN_DB_TESTS === "1" && !!process.env.DATABASE_URL;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe.runIf(enabled)("import resume", () => {
  const db = createDb(process.env.DATABASE_URL ?? "postgres://unused", { max: 6 });
  afterAll(async () => {
    await deleteDrizzleRows(db, [imports, users]);
    await db.close();
  });

  it("resumes an interrupted build, revives after Retry, and reveals documents with block rows", async () => {
    await deleteDrizzleRows(db, [imports, users]);
    const userId = randomUUID();
    const projectId = randomUUID();
    await db.insert(users).values(conformanceUserValues(userId, "import-resume"));
    await db.insert(projects).values({ id: projectId, userId, name: "Resume", slug: "resume" });
    await provisionProjectSources(db, projectId, { personal: false });
    const objects = createInMemoryObjectStore();
    const repository = createDrizzleImportRepository(db);
    const service = createImportUploadService({
      repository,
      objects,
      admission: createImportAdmission(),
      tree: {
        async destination() {
          return { folderId: null };
        },
      },
      wake: { wake() {} },
      reportError: (cause) => {
        throw cause;
      },
      previewFailed: () => undefined,
    });
    const ports = await createProductionAppPorts({
      db,
      backgroundTasks: processDetachedWork,
      eventSink: createNoopEventSink(),
      environment: { FLOW_OPENAI_API_KEY: "sk-test-import-resume" },
    });
    composeAppServices(ports);

    // The first `interruptions` reveals fail after every text is written: the pass stops between
    // its last batch and the reveal, as a restart or a lost lease would.
    let interruptions = 5;
    const failures: unknown[] = [];
    const organizer = createImportOrganizer({
      repository,
      queue: createDrizzleOrganizeQueue(db),
      objects,
      converter: {
        async convert(_bytes, imageFolder) {
          return {
            markdown: `# Chapter\n\n![fig](${imageFolder}/image-1.png)\n\nBody text.\n`,
            images: [{ name: "image-1.png", bytes: PNG }],
          };
        },
      },
      binder: ports.documentSync.importBinder,
      documents: ports.documentSync,
      read: () => createDrizzleContextImportRead(db, projectId),
      reveal: {
        async reveal(input) {
          if (interruptions-- > 0) throw new Error("interrupted");
          return revealer.reveal(input);
        },
      },
      diagnostic: (cause) => failures.push(cause),
      previewFailed: () => undefined,
    });
    const revealer = createDrizzleContextImportReveal({
      db,
      tree: treeSeeder(db).store,
      ahead: ports.linkAheadRegistry,
      arrivals: ports.documentArrivals,
    });
    const expireLease = () =>
      db
        .update(imports)
        .set({ leaseUntil: sql`clock_timestamp() - interval '1 second'` })
        .where(eq(imports.state, "organizing"));

    const input: ImportSelection = {
      importId: randomUUID(),
      destination: { folderUri: "kb://" },
      roots: [{ rootId: 0, kind: "folder", name: "Vault" }],
      folders: [],
      entries: [{ entryId: 0, rootId: 0, path: "Ch5.docx", size: 4, modifiedAt: 1 }],
    };
    await service.create(projectId, userId, input);
    await service.receive(input.importId, projectId, async () => [
      { kind: "bytes", entryId: 0, bytes: Buffer.from("docx") },
    ]);

    const signal = new AbortController().signal;
    // The first pass plans, writes the texts, and is interrupted at the reveal.
    await organizer.runPass(signal);
    // A failed pass keeps its lease: nothing to reclaim until it runs out.
    expect(await organizer.runPass(signal)).toBe(0);
    expect(failures).toHaveLength(1);
    for (let attempt = 2; attempt <= 5; attempt++) {
      await expireLease();
      await organizer.runPass(signal);
    }
    expect(failures.map((cause) => (cause as Error).message)).toEqual(Array(5).fill("interrupted"));
    expect(await repository.read(input.importId)).toMatchObject({
      state: "failed",
      reason: "organize_failed",
    });
    // The text waits in the journal; no document or node exists yet.
    expect(await db.select().from(documents)).toEqual([]);
    expect(await db.select().from(treeNodes)).toEqual([]);
    const waiting = await db
      .select({ id: documentYjsHeads.documentId })
      .from(documentYjsHeads)
      .where(eq(documentYjsHeads.kind, "document"));
    expect(waiting).toHaveLength(1);

    await service.retry(input.importId, projectId);
    expect(await organizer.runPass(signal)).toBe(1);
    expect(failures).toHaveLength(5);
    expect(await repository.read(input.importId)).toMatchObject({ state: "finished" });

    const nodes = await db.select().from(treeNodes);
    expect(
      nodes
        .filter((node) => node.kind === "folder")
        .map((node) => node.name)
        .sort(),
    ).toEqual(["Ch5", "Vault"]);
    expect(
      nodes
        .filter((node) => node.kind === "document")
        .map((node) => node.name)
        .sort(),
    ).toEqual(["Ch5", "image-1.png"]);
    expect(nodes.filter((node) => node.rank === "")).toEqual([]);
    const markdown = nodes.find((node) => node.fileType === "markdown");
    expect(markdown).toBeTruthy();
    expect((await db.select().from(documents)).map((row) => row.id)).toContain(markdown?.id);
    // Block derivation is scheduled at reveal and runs detached.
    await processDetachedWork.drain(10_000);
    const blocks = await db
      .select({ id: documentBlocks.blockId })
      .from(documentBlocks)
      .where(eq(documentBlocks.projectId, projectId as never));
    expect(blocks.length).toBeGreaterThan(0);
  }, 60_000);

  it("deletes the waiting texts of a stopped import with its objects", async () => {
    await deleteDrizzleRows(db, [imports, users]);
    const userId = randomUUID();
    const projectId = randomUUID();
    await db.insert(users).values(conformanceUserValues(userId, "import-stop"));
    await db.insert(projects).values({ id: projectId, userId, name: "Stop", slug: "stop" });
    const objects = createInMemoryObjectStore();
    const repository = createDrizzleImportRepository(db);
    const service = createImportUploadService({
      repository,
      objects,
      admission: createImportAdmission(),
      tree: {
        async destination() {
          return { folderId: null };
        },
      },
      wake: { wake() {} },
      reportError: (cause) => {
        throw cause;
      },
      previewFailed: () => undefined,
    });
    const ports = await createProductionAppPorts({
      db,
      backgroundTasks: processDetachedWork,
      eventSink: createNoopEventSink(),
      environment: { FLOW_OPENAI_API_KEY: "sk-test-import-stop" },
    });
    composeAppServices(ports);
    const organizer = createImportOrganizer({
      repository,
      queue: createDrizzleOrganizeQueue(db),
      objects,
      converter: {
        async convert() {
          throw new Error("no conversion");
        },
      },
      binder: ports.documentSync.importBinder,
      documents: ports.documentSync,
      read: () => createDrizzleContextImportRead(db, projectId),
      reveal: {
        async reveal() {
          throw new Error("interrupted");
        },
      },
      diagnostic: () => undefined,
      previewFailed: () => undefined,
    });
    const input: ImportSelection = {
      importId: randomUUID(),
      destination: { folderUri: "kb://" },
      roots: [{ rootId: 0, kind: "file", name: "note.md" }],
      folders: [],
      entries: [{ entryId: 0, rootId: 0, path: "", size: 6, modifiedAt: 1 }],
    };
    await service.create(projectId, userId, input);
    await service.receive(input.importId, projectId, async () => [
      { kind: "bytes", entryId: 0, bytes: Buffer.from("# Note") },
    ]);
    await organizer.runPass(new AbortController().signal);
    const written = () =>
      db.select().from(documentYjsHeads).where(eq(documentYjsHeads.kind, "document"));
    expect(await written()).toHaveLength(1);

    await service.stop(input.importId, projectId);
    await sweepImportObjects(repository, objects, {
      importId: input.importId,
      journals: {
        discardUnborn: (ids) => ports.documentSync.discardUnbornDocuments(ids as never),
      },
    });
    expect(await written()).toEqual([]);
  }, 60_000);
});
