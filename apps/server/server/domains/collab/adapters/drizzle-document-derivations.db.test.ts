/**
 * PostgreSQL races and recovery contracts for durable document derivation.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - lazy-cut retirement, lock-scoped capture, persistence revalidation, and durable recovery sweeps
 * - the head row as a Live command's lock: `lockDocumentMutation` takes it before the command
 *   reads, because a keystroke holds only that row (it allocates journal ids under it)
 */

import { createHash, randomUUID } from "node:crypto";
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documentBlockRooms,
  documentBlocks,
  documentLinks,
  documentYjsCheckpoints,
  linkAheadRefs,
  projects,
  users,
} from "@meridian/database/schema";
import { LIVE, type TreeWriter } from "@meridian/project-tree";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { deleteDrizzleRows } from "../../../test-support/drizzle-reset.js";
import { waitForPostgresLock } from "../../../test-support/lock-interleave.js";
import { treeListOfSource, treeSeeder } from "../../../test-support/tree-seed.js";
import {
  createDocumentLastAddress,
  createDocumentUriResolver,
} from "../../context/document-uri-resolver.js";
import { createCheckpointService } from "../checkpoints.js";
import {
  createDocumentDerivationService,
  documentHash,
  type ReadCut,
} from "../domain/document-derivations.js";
import { bindDocumentAuthority, documentAuthority } from "../domain/document-handle.js";
import {
  DOCUMENT_EXTRACTOR_VERSION,
  type DocumentDerivationOutputs,
} from "../domain/ports/document-derivations.js";
import { createHocuspocusPersistenceService } from "../hocuspocus-persistence.js";
import { createTestLinkAheadRegistry } from "../test-support/document-link-scopes.js";
import { readDocumentAuthorityHead } from "./drizzle-document-authority-head.js";
import { createDrizzleDocumentDerivationStore } from "./drizzle-document-derivations.js";
import { createDrizzleCollabPersistence } from "./drizzle-journal.js";

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
    pendingChanges: {},
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
  const documentId = randomUUID();
  const persistence = createDrizzleCollabPersistence(db);
  const store = createDrizzleDocumentDerivationStore(db, createDocumentLastAddress(db));
  const seeder = treeSeeder(db);
  let fail = false;
  /** A live edit of the tree (move, rename, delete) through the list store, as a person's would be. */
  async function liveEdit(edit: (writer: TreeWriter) => unknown) {
    await seeder.store.submit({
      lists: [await treeListOfSource(db, sourceId)],
      make: ([{ writer }]) => edit(writer),
    });
  }
  // The document's prose is one block: these cases are about cuts and certification, not blocks.
  const proseBlocks: ReadCut = async (_id, doc) => {
    if (fail) throw new Error("deriver unavailable");
    return { blocks: [proseBlock(doc.getText("prose").toString())], links: [], pendingChanges: {} };
  };
  const service = createDocumentDerivationService({
    deferred: () => {},
    store,
    readCut: proseBlocks,
    outsideTransaction: (operation) => operation(),
    failed: () => {},
  });

  beforeEach(async () => {
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
        cutAdmissionSeq: -1n,
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
    await persistence.seeds.seedInitialDocument(documentId, Y.encodeStateAsUpdate(new Y.Doc()));
  });
  afterAll(async () => {
    await service.stop();
    await db.close();
  });

  async function append(doc: Y.Doc, text: string) {
    doc.getText("prose").insert(doc.getText("prose").length, text);
    return persistence.journal.append(documentId, Y.encodeStateAsUpdate(doc), {
      origin: `human:${userId}`,
      seq: 0,
    });
  }
  async function checkpointCut() {
    const cut = await persistence.journal.captureCheckpoint(
      documentId,
      await readDocumentAuthorityHead(db, documentId),
    );
    if (!cut) throw new Error("Current authority did not produce a checkpoint cut");
    return cut;
  }
  async function projection() {
    const [row] = await db
      .select({ text: documentBlocks.text })
      .from(documentBlocks)
      .innerJoin(documentBlockRooms, eq(documentBlockRooms.roomId, documentBlocks.roomId))
      .where(eq(documentBlockRooms.documentId, documentId));
    return row?.text;
  }

  it.each(["room", "explicit"] as const)(
    "%s checkpoints preserve an admitted writer row before the room applies it",
    async (path) => {
      const room = new Y.Doc({ gc: false });
      bindDocumentAuthority(room, await readDocumentAuthorityHead(db, documentId));
      const transport = createHocuspocusPersistenceService({
        journal: persistence.journal,
        hocuspocus: () => ({ documents: new Map([[documentId, room]]) }) as never,
        metaForOrigin: () => ({ origin: `human:${userId}`, seq: 0 }),
      });
      const client = new Y.Doc({ gc: false });
      client.getText("prose").insert(0, "Words typed just before reload");
      const update = Y.encodeStateAsUpdate(client);
      let apply!: () => void;
      const held = new Promise<void>((resolve) => {
        apply = resolve;
      });
      // The awaited beforeSync admission has committed, but Hocuspocus has
      // not yet run readUpdate. Hold that exact window without timing sleeps.
      await transport.admitLiveWriterUpdate({
        documentId: documentId as never,
        document: room,
        update,
        origin: { type: "user", userId: userId as never },
      });
      const admittedSeq = await persistence.store.latestUpdateSeq(documentId);
      const before = await db
        .select({ id: documentYjsCheckpoints.id })
        .from(documentYjsCheckpoints)
        .where(eq(documentYjsCheckpoints.documentId, documentId));
      const writer = held.then(() => Y.applyUpdate(room, update));
      try {
        expect(room.getText("prose").toString()).toBe("");
        if (path === "room") {
          await transport.storeHocuspocusDocument(documentId, room);
          await transport.drainHocuspocusPersistence();
        } else {
          const checkpoints = createCheckpointService({
            coordinator: {
              withDocument: async (_id, operation) => operation(room),
            },
            store: persistence.store,
            journal: persistence.journal,
            markdownDocuments: {
              restoreFromYDoc: async () => {
                throw new Error("Not used");
              },
            },
          });
          const result = await runInDrizzleTransaction(db, () =>
            checkpoints.checkpoint(documentId, "reload"),
          );
          expect(result.ok).toBe(true);
        }
        const checkpoints = await db
          .select()
          .from(documentYjsCheckpoints)
          .where(eq(documentYjsCheckpoints.documentId, documentId));
        expect(
          checkpoints.some(
            (checkpoint) =>
              !before.some((previous) => previous.id === checkpoint.id) &&
              checkpoint.upToSeq >= admittedSeq,
          ),
        ).toBe(true);
        const cold = new Y.Doc({ gc: false });
        try {
          const state = await transport.loadHocuspocusDocument(documentId, cold);
          if (state) Y.applyUpdate(cold, state);
          expect(cold.getText("prose").toString()).toBe("Words typed just before reload");
        } finally {
          cold.destroy();
        }
      } finally {
        apply();
        await writer;
        room.destroy();
        client.destroy();
      }
    },
  );

  /**
   * Guards: a keystroke committing between a Live command's read and its rows. Its row id would sit
   * below the command's, outside the cut the command records, and the model's next concurrent-change
   * report (which reads only rows after the cut) would never name it. Fails if
   * `lockDocumentMutation` stops taking the head row: the keystroke then commits at once.
   */
  it("a keystroke waits for a command that has read the journal, and commits above its rows", async () => {
    const room = new Y.Doc({ gc: false });
    const authority = await readDocumentAuthorityHead(db, documentId);
    bindDocumentAuthority(room, authority);
    const transport = createHocuspocusPersistenceService({
      journal: persistence.journal,
      hocuspocus: () => ({ documents: new Map([[documentId, room]]) }) as never,
      metaForOrigin: () => ({ origin: `human:${userId}`, seq: 0 }),
    });
    const commandDoc = new Y.Doc({ gc: false });
    commandDoc.getText("prose").insert(0, "model");
    const typist = new Y.Doc({ gc: false });
    typist.getText("prose").insert(0, "typed");
    let read!: () => void;
    const hasRead = new Promise<void>((resolve) => {
      read = resolve;
    });
    let finish!: () => void;
    const mayFinish = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const command = runInDrizzleTransaction(db, async () => {
      await lockDocumentMutation(currentDrizzleDb(db), documentId);
      await persistence.journal.read(documentId);
      read();
      await mayFinish;
      return persistence.journal.append(documentId, Y.encodeStateAsUpdate(commandDoc), {
        origin: "system",
        seq: 0,
      });
    });
    try {
      await hasRead;
      const keystroke = transport.admitLiveWriterUpdate({
        documentId: documentId as never,
        document: room,
        update: Y.encodeStateAsUpdate(typist),
        origin: { type: "user", userId: userId as never },
      });
      await waitForPostgresLock("the keystroke to queue behind the command", async () => {
        const [waiting] = await db.execute(sql`select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`);
        return Number(waiting.n) >= 1 ? true : undefined;
      });
      finish();
      const commandSeq = await command;
      await keystroke;
      const keystrokeSeq = await persistence.store.latestUpdateSeq(documentId);
      expect(keystrokeSeq).toBeGreaterThan(commandSeq);
    } finally {
      finish();
      await command.catch(() => {});
      room.destroy();
      commandDoc.destroy();
      typist.destroy();
    }
  });

  it("capture releases its own mutation lock inside an ambient transaction before replay", async () => {
    const client = new Y.Doc({ gc: false });
    try {
      await append(client, "Before");
      const cut = await runInDrizzleTransaction(db, async () => {
        const captured = await checkpointCut();
        const locks = await currentDrizzleDb(db).execute(sql`
          select count(*)::int as count from pg_locks
          where pid = pg_backend_pid() and locktype = 'advisory'
        `);
        expect(locks[0]?.count).toBe(0);
        await lockDocumentMutation(currentDrizzleDb(db), documentId);
        await checkpointCut();
        const retained = await currentDrizzleDb(db).execute(sql`
          select count(*)::int as count from pg_locks
          where pid = pg_backend_pid() and locktype = 'advisory'
        `);
        expect(retained[0]?.count).toBe(1);
        // A later admission is outside the captured sequence range.
        await append(client, " After");
        return captured;
      });
      const cold = new Y.Doc({ gc: false });
      try {
        Y.applyUpdate(cold, await cut.materializeState());
        expect(cold.getText("prose").toString()).toBe("Before");
      } finally {
        cold.destroy();
      }
    } finally {
      client.destroy();
    }
  });

  it("parallel captures cannot roll back sibling work in an ambient transaction", async () => {
    const client = new Y.Doc({ gc: false });
    try {
      await append(client, "Before");
      const cuts = await runInDrizzleTransaction(db, async () => {
        const captures = await Promise.all(Array.from({ length: 4 }, () => checkpointCut()));
        await append(client, " After");
        return captures;
      });
      for (const cut of cuts) {
        const cold = new Y.Doc({ gc: false });
        try {
          Y.applyUpdate(cold, await cut.materializeState());
          expect(cold.getText("prose").toString()).toBe("Before");
        } finally {
          cold.destroy();
        }
      }
    } finally {
      client.destroy();
    }
  });

  it("rejects an older admission and an old-location cut without overwriting the newer projection", async () => {
    const doc = new Y.Doc({ gc: false });
    await append(doc, "old");
    const oldCut = await store.capture(documentId);
    if (!oldCut) throw new Error("Missing old cut");
    await append(doc, " new");
    await service.derive(documentId);
    expect(await store.certify(oldCut, outputsOf("old"), new Date())).toBe(false);
    expect(await projection()).toBe("old new");
    const preMove = await store.capture(documentId);
    if (!preMove) throw new Error("Missing location cut");
    await liveEdit((writer) => writer.rename(LIVE, "system", documentId, "renamed"));
    expect(await store.certify(preMove, outputsOf("wrong folder"), new Date())).toBe(false);
    expect(await projection()).toBe("old new");
    doc.destroy();
  });

  async function links() {
    return db.select().from(documentLinks).where(eq(documentLinks.sourceDocumentId, documentId));
  }

  it("certifies projection and links atomically, rejects stale cuts, and keeps ref keys across a holder move", async () => {
    const doc = new Y.Doc({ gc: false });
    const paragraph = new Y.XmlElement("paragraph");
    doc.getXmlFragment("prosemirror").push([paragraph]);
    const text = new Y.XmlText();
    paragraph.push([text]);
    const target = randomUUID();
    text.insert(0, "next", { link: { href: "manuscript://next", ref: `doc:${target}` } });
    await append(doc, "old");
    const oldCut = await store.capture(documentId);
    if (!oldCut) throw new Error("Missing old cut");
    await append(doc, " new");
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
    expect(await links()).toEqual(expected);
    await expect(
      runInDrizzleTransaction(db, async () => {
        text.format(0, text.length, {
          link: { href: "manuscript://wrong", ref: `doc:${randomUUID()}` },
        });
        await append(doc, " rolled back");
        await service.derive(documentId);
        throw new Error("rollback certification");
      }),
    ).rejects.toThrow("rollback certification");
    expect(await links()).toEqual(expected);
    expect(await projection()).toBe("old new");
    const preMove = await store.capture(documentId);
    if (!preMove) throw new Error("Missing location cut");
    const folderId = await seeder.folder(sourceId, "moved");
    await liveEdit((writer) => writer.move(LIVE, "system", documentId, folderId));
    expect(await store.certify(preMove, outputsOf("wrong folder"), new Date())).toBe(false);
    expect(await store.stale()).toEqual([documentId]);
    await service.derive(documentId);
    expect(await store.stale()).toEqual([]);
    const [watermark] = await db
      .select()
      .from(documentBlockRooms)
      .where(eq(documentBlockRooms.documentId, documentId));
    expect(await projection()).toBe("old new");
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
    expect(await projection()).toBe("old new");
    // A live document under a deleted folder holds no address there (deleted-ancestor rule).
    await liveEdit((writer) => writer.delete(LIVE, "system", folderId));
    expect((await store.capture(documentId))?.holderUri).toBeNull();
    expect(await createDocumentUriResolver(db)(documentId)).toBeNull();
    doc.destroy();
  });

  it("the sweep registers a client-minted ahead ref whose registration failed after certification", async () => {
    const real = createTestLinkAheadRegistry(db);
    let failRegistration = true;
    const aheadStore = createDrizzleDocumentDerivationStore(db, createDocumentLastAddress(db), {
      registry: {
        async registerUnregistered(scope, page) {
          if (failRegistration) throw new Error("registry unavailable");
          return real.registerUnregistered(scope, page);
        },
      },
    });
    const aheadService = createDocumentDerivationService({
      deferred: () => {},
      store: aheadStore,
      readCut: proseBlocks,
      outsideTransaction: (operation) => operation(),
      failed: () => {},
    });
    const aheadId = randomUUID();
    const doc = new Y.Doc({ gc: false });
    const paragraph = new Y.XmlElement("paragraph");
    doc.getXmlFragment("prosemirror").push([paragraph]);
    const text = new Y.XmlText();
    paragraph.push([text]);
    text.insert(0, "later", { link: { href: "manuscript://later", ref: `ahead:${aheadId}` } });
    await append(doc, "Linked");
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
    const backlog = Array.from(
      { length: 150 },
      (_, i) => `10000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    );
    for (const [i, id] of backlog.entries()) {
      text.insert(text.length, ` bulk ${i}`, {
        link: { href: `manuscript://bulk-${i}`, ref: `ahead:${id}` },
      });
    }
    await append(doc, " More");
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
    doc.destroy();
  });

  it("the recovery sweep retries a missed derive without a local hint", async () => {
    const doc = new Y.Doc({ gc: false });
    await append(doc, "Recovered");
    fail = true;
    await service.sweep();
    expect(await projection()).toBe("last good");
    fail = false;
    await service.sweep();
    expect(await projection()).toBe("Recovered");
    doc.destroy();
  });
});
