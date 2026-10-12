/** Production-composed import races against socket admission and ordinary Manuscript creation. */
import { randomUUID } from "node:crypto";
import { Hocuspocus } from "@hocuspocus/server";
import { fragmentOf, toDocHandle, yProsemirrorModel } from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts/runtime";
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documents,
  folders,
  projects,
  users,
  works,
} from "@meridian/database/schema";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema, createCollabYDoc } from "@meridian/prosemirror-schema";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { composeAppServices, createProductionAppPorts } from "../../lib/compose.js";
import {
  currentDrizzleDb,
  deferUntilDrizzleCommit,
  runInDrizzleTransaction,
} from "../../shared/drizzle-transaction.js";
import { deleteDrizzleRows } from "../../test-support/drizzle-reset.js";
import {
  createDrizzleContextBulkCreation,
  createDrizzleDocumentArrivals,
} from "../context/index.js";
import { createNoopEventSink } from "../observability/index.js";
import { createDrizzleJournal } from "./adapters/drizzle-journal.js";
import { createStaticDocumentLinkScopes } from "./adapters/in-memory/static-document-link-scopes.js";

const enabled =
  (process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true") &&
  process.env.DATABASE_URL;
describe.skipIf(!enabled)("import producer races (postgres)", () => {
  const db = createDb(process.env.DATABASE_URL ?? "postgres://unused", { max: 6 });
  const competitorDb = createDb(process.env.DATABASE_URL ?? "postgres://unused", { max: 2 });
  let userId: string, projectId: string, sourceId: string;
  let ports: Awaited<ReturnType<typeof createProductionAppPorts>>;
  let app: ReturnType<typeof composeAppServices>;
  let hp: Hocuspocus;
  const schema = buildDocumentSchema(),
    codec = mdxCodec({ schema }),
    model = yProsemirrorModel(schema);
  async function ok<T>(promise: Promise<{ ok: true; value: T } | { ok: false; error: unknown }>) {
    const result = await promise;
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return result.value;
  }
  beforeEach(async () => {
    await deleteDrizzleRows(db, [users]);
    userId = randomUUID();
    projectId = randomUUID();
    sourceId = randomUUID();
    await db.insert(users).values(conformanceUserValues(userId, "import-races"));
    await db.insert(projects).values({ id: projectId, userId, name: "Races", slug: "races" });
    await db
      .insert(works)
      .values({ projectId, createdByUserId: userId, name: "No Work", isNoWork: true });
    await db
      .insert(contextSources)
      .values({ id: sourceId, projectId, name: "Manuscript", slug: "manuscript", isPrimary: true });
    ports = await createProductionAppPorts({
      db,
      eventSink: createNoopEventSink(),
      environment: { OPENAI_API_KEY: "sk-test-races" },
    });
    app = composeAppServices(ports);
    hp = new Hocuspocus({
      yDocOptions: { gc: false, gcFilter: () => true },
      onLoadDocument: async ({ documentName, document }) => {
        const state = await ports.documentSync.loadHocuspocusDocument(documentName, document);
        if (state) Y.applyUpdate(document, state);
      },
      onStoreDocument: ({ documentName, document }) =>
        ports.documentSync.storeHocuspocusDocument(documentName, document),
    });
    ports.documentSync.bindHocuspocus(hp);
  });
  afterEach(async () => {
    hp.closeConnections();
    await Promise.all(
      [...hp.documents.keys()].map((id) => hp.debouncer.executeNow(`onStoreDocument-${id}`)),
    );
    await ports.documentSync.drainHocuspocusPersistence();
    ports.documentSync.dispose();
    // Disposal cancels timers, not already-running pulls. Join them before the
    // next fixture takes reset's exclusive table locks.
    const ids = await db.select({ id: documents.id }).from(documents);
    await Promise.all(ids.map(({ id }) => ports.documentSync.flushBranchLivePull(id)));
    await app.shutdown();
    for (const document of [...hp.documents.values()]) await hp.unloadDocument(document);
  });
  afterAll(async () => {
    await deleteDrizzleRows(db, [users]);
    await competitorDb.close();
    await db.close();
  });

  /** Keep the first transaction open until a different connection actually blocks on its lock. */
  async function contend(
    first: () => Promise<unknown>,
    second: () => Promise<unknown>,
    rollback: boolean,
  ) {
    let acquired!: () => void, release!: () => void;
    const acquiredPromise = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const producer = runInDrizzleTransaction(db, async () => {
      const value = await first();
      acquired();
      await held;
      if (rollback) throw new Error("rollback first producer");
      return value;
    });
    // Own both rejections immediately, including failures before the barrier.
    const owned = producer.then(
      (value) => ({ value }),
      (error: Error) => ({ error }),
    );
    let competing: Promise<unknown> | undefined;
    let competingPid = 0;
    let competingOutcome: Promise<{ value: unknown } | { error: Error }> | undefined;
    try {
      await Promise.race([
        acquiredPromise,
        owned.then((result) => {
          if ("error" in result) throw result.error;
          throw new Error("producer finished before its barrier");
        }),
      ]);
      competing = runInDrizzleTransaction(competitorDb, async () => {
        const [backend] = await currentDrizzleDb(competitorDb).execute<{ pid: number }>(
          sql`SELECT pg_backend_pid() AS pid`,
        );
        competingPid = backend.pid;
        return second();
      });
      competingOutcome = competing.then(
        (value) => ({ value }),
        (error: Error) => ({ error }),
      );
      for (let attempt = 0; ; attempt++) {
        const rows = await db.execute<{ count: number }>(sql`
          SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND pid = ${competingPid} AND cardinality(pg_blocking_pids(pid)) > 0
        `);
        if ((rows[0]?.count ?? 0) > 0) break;
        if (attempt >= 250) throw new Error("producer never contended on a database lock");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      release();
      const [a, b] = await Promise.all([owned, competingOutcome]);
      if (rollback) expect(a).toMatchObject({ error: { message: "rollback first producer" } });
      else if ("error" in a) throw a.error;
      return b;
    } finally {
      release();
      await Promise.allSettled([owned, competingOutcome]);
    }
  }

  it.each(
    (["fill", "writer"] as const).flatMap((first) =>
      [false, true].map((rollback) => ({ first, rollback })),
    ),
  )("fill versus socket admission first=$first rollback=$rollback preserves committed writer content", async ({
    first,
    rollback,
  }) => {
    const context = app.contextPorts.forProject(projectId, userId, new Map());
    const id = (await ok(context.createTrackedDocument("kb://pending", "")))
      .documentId as DocumentId;
    const connection = await hp.openDirectConnection(id);
    const room = connection.document;
    if (!room) throw new Error("missing room");
    const client = createCollabYDoc({ gc: false });
    try {
      Y.applyUpdate(client, Y.encodeStateAsUpdate(room));
      const before = Y.encodeStateVector(client);
      model.insertBlocks(toDocHandle(client), null, { blocks: codec.parse("writer").blocks });
      const update = Y.encodeStateAsUpdate(client, before);
      const bound = await ports.documentSync.bindMarkdown({
        holder: { documentId: id },
        markdown: "imported",
      });
      const generation = await ports.documentSync.currentLiveGeneration(id);
      const fill = () => ports.documentSync.fillEmptyDocument(id, bound);
      const writer = async () => {
        const result = await ports.documentSync.admitLiveWriterUpdate({
          documentId: id,
          document: room,
          update,
          origin: { type: "user", userId },
          expectedGeneration: generation,
        });
        expect(result.admitted).toBe(true);
        // This models the socket's pre-apply boundary: only the committed admission broadcasts.
        deferUntilDrizzleCommit(() => {
          Y.applyUpdate(room, update);
        });
        return result;
      };
      const loser = await contend(
        first === "fill" ? fill : writer,
        first === "fill" ? writer : fill,
        rollback,
      );
      if ("error" in loser) throw loser.error;
      if (first === "writer") {
        expect(loser.value).toMatchObject({
          ok: true,
          value: rollback ? { updateSeq: expect.any(Number) } : null,
        });
      }
      const read = await ok(ports.documentSync.readAsMarkdown(id));
      expect(read.includes("imported")).toBe(first === "fill" ? !rollback : rollback);
      expect(read.includes("writer")).toBe(first === "fill" || !rollback);
      expect(
        codec.serialize(
          model.projectBlocks(toDocHandle(room)),
          createStaticDocumentLinkScopes().reader({ uri: null, view: { kind: "live" } }),
        ),
      ).toBe(read);
      expect((await createDrizzleJournal(db).read(id)).updates).toHaveLength(
        !rollback && first === "fill" ? 2 : 1,
      );
      if (first === "fill" || !rollback) {
        const writerNode = fragmentOf(client).get(0);
        const writerRoomNode = fragmentOf(room)
          .toArray()
          .find((node) => node.toString().includes("writer"));
        expect(writerRoomNode?._item?.id).toEqual(writerNode._item?.id);
      }
    } finally {
      client.destroy();
      await connection.disconnect();
    }
  });

  it.each(
    (["bulk", "ordinary"] as const).flatMap((first) =>
      [false, true].map((rollback) => ({ first, rollback })),
    ),
  )("Manuscript chunk versus ordinary create first=$first rollback=$rollback has one namespace winner", async ({
    first,
    rollback,
  }) => {
    const context = app.contextPorts.forProject(projectId, userId, new Map());
    const scope = { kind: "project" as const, projectId: projectId as never };
    const beforeCatalog = await ports.contextCatalog.snapshot(scope);
    const placeholderId = randomUUID() as DocumentId,
      extraId = randomUUID() as DocumentId,
      folderId = randomUUID();
    const aheadId = randomUUID();
    await ports.linkAheadRegistry.register([
      { aheadId, holderProjectId: projectId, address: "manuscript://same" },
    ]);
    let refreshes = 0;
    const bulk = createDrizzleContextBulkCreation({
      db,
      documents: ports.documentSync,
      recordMembership: () => ports.documentSync.reconcileProjectManifest(projectId as never),
      arrivals: createDrizzleDocumentArrivals(db, ports.linkAheadRegistry),
      catalog: {
        refreshSources: async (ids) => {
          refreshes++;
          return ports.contextCatalog.refreshSources(ids);
        },
      },
    });
    const placeholder = (id: string, name: string) => ({
      id,
      folderId: null,
      name,
      extension: "",
      filetype: "markdown" as const,
      metadata: { importPending: true },
    });
    const chunk = () =>
      bulk.create({
        contextSourceId: sourceId,
        folders: [{ id: folderId, parentId: null, name: "chunk-folder" }],
        placeholders: [placeholder(placeholderId, "same"), placeholder(extraId, "extra")],
      });
    const ordinaryBound = await ok(context.bindTrackedDocument("manuscript://same", "ordinary"));
    const ordinary = async () =>
      ok(context.createBoundDocument("manuscript://same", ordinaryBound));
    const loser = await contend(
      first === "bulk" ? chunk : ordinary,
      first === "bulk" ? ordinary : chunk,
      rollback,
    );
    if (rollback && "error" in loser) throw loser.error;
    if (!rollback) expect(loser).toHaveProperty("error");
    const bulkWon = first === "bulk" ? !rollback : rollback;
    const rows = await db.select().from(documents).where(eq(documents.contextSourceId, sourceId));
    const content = rows.filter((row) => row.kind === "content");
    expect(content.map((row) => row.name).sort()).toEqual(bulkWon ? ["extra", "same"] : ["same"]);
    const winner = content.find((row) => row.name === "same");
    if (!winner) throw new Error("missing winner");
    expect(winner.id === placeholderId).toBe(bulkWon);
    expect(await ports.linkAheadRegistry.settleRef(aheadId, extraId)).toEqual({
      settled: false,
      documentId: winner.id,
    });
    expect(await db.select().from(folders).where(eq(folders.id, folderId))).toHaveLength(
      bulkWon ? 1 : 0,
    );
    expect((await createDrizzleJournal(db).read(placeholderId)).checkpoint !== null).toBe(bulkWon);
    const membership = await ports.documentSync.resolveManifestMembership({
      projectId: projectId as never,
    });
    expect([...membership.members].sort()).toEqual(content.map((row) => row.id).sort());
    const catalog = await ports.contextCatalog.snapshot({
      kind: "project",
      projectId: projectId as never,
    });
    const files = catalog.entries.filter(
      (entry) => entry.kind === "file" && content.some((row) => row.id === entry.entryId),
    );
    expect(files).toHaveLength(content.length);
    // Manuscript refreshes publish through a post-commit catalog repair.
    expect(await ports.backgroundTasks.drain(10_000)).toBe(true);
    const changes = await ports.contextCatalog.changes(scope, beforeCatalog.cursor);
    expect(changes.kind).toBe("delta");
    if (changes.kind !== "delta") throw new Error("unexpected catalog reset");
    const changedIds = new Set(
      changes.commits.flatMap((commit) =>
        commit.changes.flatMap((change) =>
          change.operation === "upsert" ? [change.entry.entryId] : [],
        ),
      ),
    );
    for (const row of content) expect(changedIds.has(row.id)).toBe(true);
    if (!bulkWon) {
      expect(changedIds.has(placeholderId)).toBe(false);
      expect(changedIds.has(extraId)).toBe(false);
      expect(changedIds.has(folderId)).toBe(false);
    }
    expect(files.every((entry) => entry.kind === "file" && entry.importPending === bulkWon)).toBe(
      true,
    );
    expect(refreshes).toBe(first === "bulk" || bulkWon ? 1 : 0);
    expect(await ok(ports.documentSync.readAsMarkdown(winner.id))).toBe(
      bulkWon ? "" : "ordinary\n",
    );
  });
});
