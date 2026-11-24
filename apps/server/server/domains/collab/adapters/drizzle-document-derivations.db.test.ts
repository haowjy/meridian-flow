/**
 * PostgreSQL races and recovery contracts for durable document derivation.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - a cut is certified against `documents.content_seq`, which every save of the Live room bumps,
 *   and against the document's location version; a stale cut writes nothing
 * - lazy-cut retirement and durable recovery sweeps
 */

import { createHash, randomUUID } from "node:crypto";
import {
  createAgentEditCodecFactory,
  LoroDocument,
  loroModel,
  toLoroHandle,
} from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts/runtime";
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documentBlockRooms,
  documentBlocks,
  documentLinks,
  linkAheadRefs,
  projects,
  users,
} from "@meridian/database/schema";
import { encodeEnvelope } from "@meridian/document-model";
import { shapeSchemaOf } from "@meridian/loro-prosemirror";
import { mdxCodec } from "@meridian/markup";
import { LIVE, type TreeWriter } from "@meridian/project-tree";
import {
  buildDocumentSchema,
  COLLAB_SCHEMA_VERSION,
  packCollabSchemaVersion,
} from "@meridian/prosemirror-schema";
import { asc, eq, inArray, sql } from "drizzle-orm";
import type { Mark, Node as PMNode } from "prosemirror-model";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  currentDrizzleDb,
  isInDrizzleTransaction,
  runInDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import { deleteDrizzleRows } from "../../../test-support/drizzle-reset.js";
import { treeListOfSource, treeSeeder } from "../../../test-support/tree-seed.js";
import {
  createDocumentLastAddress,
  createDocumentUriResolver,
} from "../../context/document-uri-resolver.js";
import { createNoopEventSink } from "../../observability/index.js";
import {
  createCutReader,
  createDocumentDerivationService,
  documentHash,
  type ReadCut,
} from "../domain/document-derivations.js";
import {
  DOCUMENT_EXTRACTOR_VERSION,
  type DocumentDerivationOutputs,
} from "../domain/ports/document-derivations.js";
import { createPostgresDocumentRooms } from "../rooms/postgres-document-rooms.js";
import { createTestLinkAheadRegistry } from "../test-support/document-link-scopes.js";
import { createDrizzleDocumentDerivationStore } from "./drizzle-document-derivations.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DB suites require DATABASE_URL");

function proseBlock(text: string) {
  return {
    id: "prose",
    text,
    contentHash: createHash("sha256").update(text).digest(),
  };
}

function outputsOf(text: string): DocumentDerivationOutputs {
  const blocks = [proseBlock(text)];
  return {
    blocks,
    wordCount: 0,
    documentBytes: text.length,
    documentHash: documentHash(blocks, []),
    links: [],
  };
}

describe("durable document derivations", () => {
  const db = createDb(DATABASE_URL, { max: 6 });
  const userId = randomUUID();
  const projectId = randomUUID();
  const sourceId = randomUUID();
  const documentId = randomUUID() as DocumentId;
  const schema = buildDocumentSchema();
  const model = loroModel(schema);
  const rooms = createPostgresDocumentRooms({
    db,
    shape: shapeSchemaOf(schema),
    eventSink: createNoopEventSink(),
    schemaVersion: packCollabSchemaVersion(COLLAB_SCHEMA_VERSION),
  });
  const live = { kind: "live", documentId } as const;
  const readLive = async (id: DocumentId) =>
    new LoroDocument(await rooms.read({ kind: "live", documentId: id }), schema);
  const store = createDrizzleDocumentDerivationStore(db, createDocumentLastAddress(db), readLive);
  const seeder = treeSeeder(db);
  let fail = false;
  /** A live edit of the tree (move, rename, delete) through the list store, as a person's would be. */
  async function liveEdit(edit: (writer: TreeWriter) => unknown) {
    await seeder.store.submit({
      lists: [await treeListOfSource(db, sourceId)],
      make: ([{ writer }]) => edit(writer),
    });
  }
  const cutReader = createCutReader({
    schema,
    codec: () => createAgentEditCodecFactory(mdxCodec({ schema })),
    resolveFiletype: async () => null,
  });
  const readCut: ReadCut = async (id, doc) => {
    if (fail) throw new Error("deriver unavailable");
    return cutReader(id, doc);
  };
  const service = createDocumentDerivationService({
    deferred: () => {},
    store,
    readCut,
    outsideTransaction: (operation) => operation(),
    failed: () => {},
  });

  beforeEach(async () => {
    await rooms.unload(live);
    await deleteDrizzleRows(db, [users]);
    fail = false;
    await db.insert(users).values(conformanceUserValues(userId, "derivations"));
    await db
      .insert(projects)
      .values({ id: projectId, userId, name: "Derivations", slug: "derivations" });
    await db.insert(contextSources).values({
      id: sourceId,
      projectId,
      slug: "manuscript",
      scope: "project",
    });
    await seeder.document(sourceId, "chapter", { id: documentId });
    // A room from an older cut: what a failed derive leaves standing.
    const [room] = await db
      .insert(documentBlockRooms)
      .values({
        documentId,
        blockOrder: ["prose"],
        wordCount: 0,
        documentHash: outputsOf("last good").documentHash,
        cutContentSeq: -1n,
        cutLocationVersion: -1n,
        extractorVersion: DOCUMENT_EXTRACTOR_VERSION,
      })
      .returning({ roomId: documentBlockRooms.roomId });
    await db.insert(documentBlocks).values({
      roomId: (room as { roomId: number }).roomId,
      blockId: "prose",
      text: "last good",
      contentHash: proseBlock("last good").contentHash,
    });
  });
  afterAll(async () => {
    await service.stop();
    await rooms.close();
    await db.close();
  });

  /** A command's write: `blocks` appended to the Live room, saved in its transaction. */
  async function appendBlocks(blocks: PMNode[]) {
    const docs = await rooms.read(live);
    try {
      const before = docs.version();
      const doc = toLoroHandle(new LoroDocument(docs, schema));
      model.insertBlocks(doc, model.getBlocks(doc).at(-1) ?? null, { blocks });
      const batch = encodeEnvelope(docs.exportSince(before));
      await runInDrizzleTransaction(db, () =>
        rooms.commit(currentDrizzleDb(db), live, batch, "server:test"),
      );
      // The loaded room saves the batch again after its 2 s debounce, which a slow case would race.
      if (!isInDrizzleTransaction()) await rooms.flush(live);
    } finally {
      docs.free();
    }
  }
  const append = (text: string, marks?: readonly Mark[]) =>
    appendBlocks([schema.nodes.paragraph.create(null, schema.text(text, marks))]);
  /** The certified text, its blocks in document order. */
  async function projection() {
    const [room] = await db
      .select({ order: documentBlockRooms.blockOrder, roomId: documentBlockRooms.roomId })
      .from(documentBlockRooms)
      .where(eq(documentBlockRooms.documentId, documentId));
    if (!room) return undefined;
    const rows = await db
      .select({ blockId: documentBlocks.blockId, text: documentBlocks.text })
      .from(documentBlocks)
      .where(eq(documentBlocks.roomId, room.roomId))
      .orderBy(asc(documentBlocks.blockId));
    const text = new Map(rows.map((row) => [row.blockId, row.text]));
    return room.order.map((id) => text.get(id)).join(" ");
  }
  const link = (href: string, ref: string) => [
    schema.marks.link.create({ href, ref, title: null }),
  ];

  it("rejects an older admission and an old-location cut without overwriting the newer projection", async () => {
    await append("old");
    const oldCut = await store.capture(documentId);
    if (!oldCut) throw new Error("Missing old cut");
    await append("new");
    await service.derive(documentId);
    expect(await store.certify(oldCut, outputsOf("old"), new Date())).toBe(false);
    expect(await projection()).toBe("old new");
    const preMove = await store.capture(documentId);
    if (!preMove) throw new Error("Missing location cut");
    await liveEdit((writer) => writer.rename(LIVE, "system", documentId, "renamed"));
    expect(await store.certify(preMove, outputsOf("wrong folder"), new Date())).toBe(false);
    expect(await projection()).toBe("old new");
  });

  async function links() {
    return db.select().from(documentLinks).where(eq(documentLinks.sourceDocumentId, documentId));
  }

  it("certifies projection and links atomically, rejects stale cuts, and keeps ref keys across a holder move", async () => {
    const target = randomUUID();
    await append("next", link("manuscript://next", `doc:${target}`));
    const oldCut = await store.capture(documentId);
    if (!oldCut) throw new Error("Missing old cut");
    await append("new");
    await service.derive(documentId);
    const expected = [
      {
        sourceDocumentId: documentId,
        linkKey: `doc:${target}`,
        targetDocumentId: target,
        aheadId: null,
        address: "manuscript://next",
        occurrences: 1,
      },
    ];
    expect(await links()).toEqual(expected);
    expect(await store.certify(oldCut, outputsOf("old"), new Date())).toBe(false);
    oldCut.doc.docs.free();
    expect(await links()).toEqual(expected);
    // A write and its derive in one transaction that rolls back: neither the room nor the
    // projection keeps anything of it.
    await expect(
      runInDrizzleTransaction(db, async () => {
        await append("rolled back", link("manuscript://wrong", `doc:${randomUUID()}`));
        await service.derive(documentId);
        throw new Error("rollback certification");
      }),
    ).rejects.toThrow("rollback certification");
    expect(await links()).toEqual(expected);
    expect(await projection()).toBe("[next]() new");
    const preMove = await store.capture(documentId);
    if (!preMove) throw new Error("Missing location cut");
    const folderId = await seeder.folder(sourceId, "moved");
    await liveEdit((writer) => writer.move(LIVE, "system", documentId, folderId));
    expect(await store.certify(preMove, outputsOf("wrong folder"), new Date())).toBe(false);
    preMove.doc.docs.free();
    expect(await store.stale()).toEqual([documentId]);
    await service.derive(documentId);
    expect(await store.stale()).toEqual([]);
    const [watermark] = await db
      .select()
      .from(documentBlockRooms)
      .where(eq(documentBlockRooms.documentId, documentId));
    expect(await projection()).toBe("[next]() new");
    // The holder moved; its ref-keyed rows did not change, and nothing was written into it.
    expect(await links()).toEqual(expected);
    expect(watermark?.cutLocationVersion).toBe(1n);
    expect(watermark?.extractorVersion).toBe(DOCUMENT_EXTRACTOR_VERSION);
    await db
      .update(documentBlockRooms)
      .set({ extractorVersion: 1 })
      .where(eq(documentBlockRooms.documentId, documentId));
    // Same content hash, stale text: only the version says the text is out of date.
    await db
      .update(documentBlocks)
      .set({ text: "STALE" })
      .where(
        inArray(
          documentBlocks.roomId,
          db
            .select({ id: documentBlockRooms.roomId })
            .from(documentBlockRooms)
            .where(eq(documentBlockRooms.documentId, documentId)),
        ),
      );
    expect(await store.stale()).toEqual([documentId]);
    await service.derive(documentId);
    expect(await store.stale()).toEqual([]);
    expect(await projection()).toBe("[next]() new");
    // A live document under a deleted folder holds no address there (deleted-ancestor rule).
    await liveEdit((writer) => writer.delete(LIVE, "system", folderId));
    const deleted = await store.capture(documentId);
    expect(deleted?.holderUri).toBeNull();
    deleted?.doc.docs.free();
    expect(await createDocumentUriResolver(db)(documentId)).toBeNull();
  });

  it("the sweep registers a client-minted ahead ref whose registration failed after certification", async () => {
    const real = createTestLinkAheadRegistry(db);
    let failRegistration = true;
    const aheadStore = createDrizzleDocumentDerivationStore(
      db,
      createDocumentLastAddress(db),
      readLive,
      {
        registry: {
          async registerUnregistered(scope, page) {
            if (failRegistration) throw new Error("registry unavailable");
            return real.registerUnregistered(scope, page);
          },
        },
      },
    );
    const aheadService = createDocumentDerivationService({
      deferred: () => {},
      store: aheadStore,
      readCut,
      outsideTransaction: (operation) => operation(),
      failed: () => {},
    });
    const aheadId = randomUUID();
    await append("later", link("manuscript://later", `ahead:${aheadId}`));
    const registered = () =>
      db.select().from(linkAheadRefs).where(eq(linkAheadRefs.aheadId, aheadId));

    expect(await aheadService.derive(documentId)).toMatchObject({ status: "derived" });
    expect(await links()).toEqual([
      expect.objectContaining({ aheadId, address: "manuscript://later" }),
    ]);
    expect(await registered()).toEqual([]);
    // Certified and unchanged: only the anti-join recovery can still find the ref.
    expect(await aheadStore.stale()).toEqual([]);
    failRegistration = false;
    await aheadService.sweep();
    expect(await registered()).toEqual([
      expect.objectContaining({ scheme: "manuscript", path: "later", settledDocumentId: null }),
    ]);

    // More refs than one page: the holder's registration drains them all before a move locks.
    const bulk = Array.from({ length: 150 }, (_, i) =>
      schema.text(
        `bulk ${i} `,
        link(
          `manuscript://bulk-${i}`,
          `ahead:10000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
        ),
      ),
    );
    await appendBlocks([schema.nodes.paragraph.create(null, bulk)]);
    expect(await aheadService.derive(documentId)).toMatchObject({ status: "derived" });
    const unregistered = async () => {
      const [row] = await db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM document_links l
        LEFT JOIN link_ahead_refs a ON a.ahead_id = l.ahead_id
        WHERE l.ahead_id IS NOT NULL AND a.ahead_id IS NULL`);
      return row?.n;
    };
    expect(await unregistered()).toBe(0);

    // A full page of refs that can never register (no such Work) ahead of a valid one: the
    // sweep advances past what it attempted, so the valid ref registers on the next pass.
    const poison = Array.from({ length: 100 }, (_, i) => {
      const id = `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
      return {
        sourceDocumentId: documentId,
        linkKey: `ahead:${id}`,
        aheadId: id,
        address: "scratch://@w99/later",
        occurrences: 1,
      };
    });
    const valid = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await db.insert(documentLinks).values([
      ...poison,
      {
        sourceDocumentId: documentId,
        linkKey: `ahead:${valid}`,
        aheadId: valid,
        address: "manuscript://recoverable",
        occurrences: 1,
      },
    ]);
    await aheadService.sweep();
    await aheadService.sweep();
    expect(
      await db.select().from(linkAheadRefs).where(eq(linkAheadRefs.aheadId, valid)),
    ).toHaveLength(1);
    await aheadService.stop();
  });

  it("the recovery sweep retries a missed derive without a local hint", async () => {
    await append("Recovered");
    fail = true;
    await service.sweep();
    expect(await projection()).toBe("last good");
    fail = false;
    await service.sweep();
    expect(await projection()).toBe("Recovered");
  });
});
