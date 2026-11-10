/** An import with a DOCX that holds an image survives interrupted builds, against real Postgres.
 *
 * Protects:
 * - A build interrupted after its first staged batch resumes without staging a node twice,
 *   including the image folder no import entry stands for (a duplicate-key failure).
 * - Retry revives an import that used up its tries.
 * - A failed pass is not reclaimed at once.
 * - After reveal, the Markdown document and the image are live and the document has block rows.
 * - Into an area the reveal creates, every visible row takes a rank, so a drag relative to one
 *   places instead of answering stale-anchor.
 */
import { randomUUID } from "node:crypto";
import type { ImportSelection } from "@meridian/contracts";
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextStagedDocuments,
  contextStagedFolders,
  documentBlocks,
  documents,
  folders,
  imports,
  projects,
  users,
} from "@meridian/database/schema";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { composeAppServices, createProductionAppPorts } from "../../lib/compose.js";
import { deleteDrizzleRows } from "../../test-support/drizzle-reset.js";
import {
  createDrizzleContextImportRead,
  createDrizzleContextStagedCreation,
} from "../context/index.js";
import { createNoopEventSink } from "../observability/index.js";
import { processDetachedWork } from "../runtime/detached-work.js";
import { createInMemoryObjectStore } from "../storage/index.js";
import { createDrizzleImportRepository } from "./adapters/drizzle-import-repository.js";
import { createDrizzleOrganizeQueue } from "./adapters/drizzle-organize-queue.js";
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

    // The first `interruptions` reveals fail after everything is staged: the pass stops between
    // its last staged batch and the reveal, as a restart or a lost lease would.
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
      context: (record) => {
        const staged = createDrizzleContextStagedCreation({
          db,
          projectId,
          userId: record.userId,
          documents: ports.documentSync,
          ahead: ports.linkAheadRegistry,
          arrivals: ports.documentArrivals,
          catalog: ports.contextCatalog,
        });
        return {
          read: createDrizzleContextImportRead(db, projectId),
          staged: {
            ...staged,
            async commitStaged(stagingId, expected) {
              if (interruptions-- > 0) throw new Error("interrupted");
              return staged.commitStaged(stagingId, expected);
            },
          },
        };
      },
      diagnostic: (cause) => failures.push(cause),
      previewFailed: () => undefined,
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
    // The first claim fixes the placement; the next builds, stages, and is interrupted.
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
    const staged = async () => [
      ...(await db.select().from(contextStagedFolders)),
      ...(await db.select().from(contextStagedDocuments)),
    ];
    expect(await staged()).toHaveLength(4);

    await service.retry(input.importId, projectId);
    expect(await organizer.runPass(signal)).toBe(1);
    expect(failures).toHaveLength(5);
    expect(await repository.read(input.importId)).toMatchObject({ state: "finished" });
    expect(await staged()).toHaveLength(0);

    const revealedFolders = await db.select().from(folders);
    expect(revealedFolders.map((folder) => folder.name).sort()).toEqual(["Ch5", "Vault"]);
    const revealed = await db.select().from(documents);
    expect(revealed.map((document) => `${document.name}.${document.extension}`).sort()).toEqual([
      "Ch5.",
      "image-1.png",
    ]);
    expect([...revealedFolders, ...revealed].filter((row) => row.rank === null)).toEqual([]);
    const markdown = revealed.find((document) => document.fileType === "markdown");
    expect(markdown).toBeTruthy();
    // Block derivation is scheduled at reveal and runs detached.
    await processDetachedWork.drain(10_000);
    const blocks = await db
      .select({ id: documentBlocks.blockId })
      .from(documentBlocks)
      .where(eq(documentBlocks.projectId, projectId as never));
    expect(blocks.length).toBeGreaterThan(0);
  }, 60_000);
});
