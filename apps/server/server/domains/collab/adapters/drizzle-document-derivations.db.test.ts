/** PostgreSQL races and recovery contracts for durable document derivation. */
import { randomUUID } from "node:crypto";
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documentDerivations,
  documentLinks,
  documents,
  documentYjsCheckpoints,
  documentYjsUpdates,
  folders,
  projects,
  users,
} from "@meridian/database/schema";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { deleteDrizzleRows } from "../../../test-support/drizzle-reset.js";
import { recordDocumentMove } from "../../context/adapters/context-fs/document-locations.js";
import { resolveDocumentUri } from "../../context/document-uri-resolver.js";
import { createDrizzleProjectWorkAuthorityResolver } from "../../projects/index.js";
import { createCheckpointService } from "../checkpoints.js";
import { createDocumentDerivationService } from "../domain/document-derivations.js";
import {
  bindDocumentAuthority,
  documentAuthority,
  RetiredDocumentHandleError,
} from "../domain/document-handle.js";
import { createHocuspocusPersistenceService } from "../hocuspocus-persistence.js";
import { createDrizzleAuthorityGenerationReplacement } from "./drizzle-authority-generation-replacement.js";
import {
  ensureAndReadDocumentAuthorityHead,
  replaceDocumentAuthorityHeadGeneration,
} from "./drizzle-document-authority-head.js";
import { createDrizzleDocumentDerivationStore } from "./drizzle-document-derivations.js";
import { createDrizzleDocumentLinkRewrite } from "./drizzle-document-link-rewrite.js";
import { lockDocumentMutation } from "./drizzle-document-mutation-lock.js";
import { createDrizzleCollabPersistence } from "./drizzle-journal.js";
import { createHocuspocusCoordinatorForTest } from "./hocuspocus-coordinator.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DB suites require DATABASE_URL");

describe("durable document derivations", () => {
  const db = createDb(DATABASE_URL, { max: 6 });
  const userId = randomUUID();
  const projectId = randomUUID();
  const sourceId = randomUUID();
  const documentId = randomUUID();
  const persistence = createDrizzleCollabPersistence(db);
  const store = createDrizzleDocumentDerivationStore(db, (tx, id) =>
    resolveDocumentUri(tx, createDrizzleProjectWorkAuthorityResolver(db), id),
  );
  let fail = false;
  const service = createDocumentDerivationService({
    deferred: () => {},
    store,
    serializer: {
      async serializeDocument(_id, doc) {
        if (fail) throw new Error("serializer unavailable");
        return doc.getText("prose").toString();
      },
    },
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
      name: "Manuscript",
      slug: "manuscript",
      scope: "project",
    });
    await db.insert(documents).values({
      id: documentId,
      contextSourceId: sourceId,
      name: "chapter",
      markdownProjection: "last good",
    });
    await persistence.lifecycle.ensureDocument(documentId);
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
  async function projection() {
    const [row] = await db.select().from(documents).where(eq(documents.id, documentId));
    return row?.markdownProjection;
  }

  it("refuses writer and agent bytes checked before a restore while queued on the mutation lock", async () => {
    const room = new Y.Doc({ gc: false });
    const beforeSeq = await append(room, "Before");
    await persistence.journal.checkpoint(documentId, Y.encodeStateAsUpdate(room), beforeSeq);
    const authority = await ensureAndReadDocumentAuthorityHead(db, documentId);
    const checkpointId = await persistence.store.createCheckpoint(
      documentId,
      Y.encodeStateAsUpdate(room),
      "saved",
      beforeSeq,
      authority,
    );
    if (!checkpointId) throw new Error("Missing checkpoint");
    await append(room, "After");
    bindDocumentAuthority(room, authority);
    const hp = { documents: new Map([[documentId, room]]), closeConnections: () => {} };
    const transport = createHocuspocusPersistenceService({
      journal: persistence.journal,
      hocuspocus: () => hp as never,
      latestUpdateSeq: persistence.store.latestUpdateSeq,
      metaForOrigin: () => ({ origin: `human:${userId}`, seq: 0 }),
      emitAgentEditInvariantViolation: () => {},
    });
    const coordinator = createHocuspocusCoordinatorForTest({
      journal: persistence.journal,
      hocuspocus: () => hp as never,
      openLiveDoc: async () => ({ doc: room, release: async () => {} }),
    });
    const restore = createDrizzleAuthorityGenerationReplacement({
      db,
      coordinator,
      checkpoints: persistence.store,
      onReplaced: () => {},
      disconnectGeneration: transport.disconnectLiveGeneration,
    });
    const client = new Y.Doc({ gc: false });
    Y.applyUpdate(client, Y.encodeStateAsUpdate(room));
    client.getText("prose").insert(client.getText("prose").length, " Stale writer");
    const stale = Y.encodeStateAsUpdate(client);
    const captured = documentAuthority(room);
    let unlock!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const blocker = db.transaction(async (tx) => {
      await lockDocumentMutation(tx, documentId);
      locked();
      await gate;
    });
    async function waitForQueued(count: number) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const rows = await db.execute(sql`select count(*)::int as n from pg_locks
          where locktype = 'advisory' and not granted
          and database = (select oid from pg_database where datname = current_database())`);
        if (Number(rows[0].n) >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Mutation admissions did not reach the lock queue");
    }
    await ready;
    try {
      const replacement = restore(documentId, checkpointId);
      await waitForQueued(1);
      const writer = transport
        .admitLiveWriterUpdate({
          documentId: documentId as never,
          document: room,
          update: stale,
          expectedGeneration: captured.generation,
          origin: { type: "user", userId },
        })
        .catch((cause: unknown) => cause);
      await waitForQueued(2);
      const agent = persistence.journal
        .appendBatch([
          {
            docId: documentId,
            update: stale,
            meta: { origin: "system", seq: 0 },
            authority: captured,
          },
        ])
        .catch((cause: unknown) => cause);
      await waitForQueued(3);
      unlock();
      await blocker;
      expect(await replacement).toEqual({ generation: 2n });
      expect.soft(await writer).toBeInstanceOf(RetiredDocumentHandleError);
      expect.soft(await agent).toBeInstanceOf(RetiredDocumentHandleError);
      await transport.drainHocuspocusPersistence();
      for (const snapshot of [
        await persistence.journal.read(documentId),
        await persistence.journal.readForReconstruction(documentId),
      ]) {
        const restored = new Y.Doc();
        if (snapshot.checkpoint) Y.applyUpdate(restored, snapshot.checkpoint);
        for (const row of snapshot.updates) Y.applyUpdate(restored, row.update);
        expect.soft(restored.getText("prose").toString()).toBe("Before");
        expect.soft(snapshot.updates).toHaveLength(0);
        restored.destroy();
      }
    } finally {
      unlock();
      await blocker;
      room.destroy();
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
    expect(await store.certify(oldCut, { markdown: "old", links: [] }, new Date())).toBe(false);
    expect(await projection()).toBe("old new");
    const preMove = await store.capture(documentId);
    if (!preMove) throw new Error("Missing location cut");
    await runInDrizzleTransaction(db, async () => {
      await recordDocumentMove(
        db,
        sourceId,
        sourceId,
        [{ id: documentId, path: "/chapter.md", kind: "file" }],
        "/chapter.md",
        "/renamed.md",
      );
    });
    expect(await store.certify(preMove, { markdown: "wrong folder", links: [] }, new Date())).toBe(
      false,
    );
    expect(await projection()).toBe("old new");
    doc.destroy();
  });

  async function links() {
    return db.select().from(documentLinks).where(eq(documentLinks.sourceDocumentId, documentId));
  }

  it("certifies projection and links atomically, rejects stale cuts, and re-keys a moved holder", async () => {
    const doc = new Y.Doc({ gc: false });
    const paragraph = new Y.XmlElement("paragraph");
    doc.getXmlFragment("prosemirror").push([paragraph]);
    const text = new Y.XmlText();
    paragraph.push([text]);
    text.insert(0, "next", { link: { href: "next.md" } });
    await append(doc, "old");
    const oldCut = await store.capture(documentId);
    if (!oldCut) throw new Error("Missing old cut");
    await append(doc, " new");
    await service.derive(documentId);
    const expected = [
      {
        sourceDocumentId: documentId,
        href: "next.md",
        targetKey: "manuscript://next.md",
        targetProjectId: projectId,
        occurrences: 1,
      },
    ];
    expect(await links()).toEqual(expected);
    expect(await store.certify(oldCut, { markdown: "old", links: [] }, new Date())).toBe(false);
    expect(await links()).toEqual(expected);
    await expect(
      runInDrizzleTransaction(db, async () => {
        text.format(0, text.length, { link: { href: "wrong.md" } });
        await append(doc, " rolled back");
        await service.derive(documentId);
        throw new Error("rollback certification");
      }),
    ).rejects.toThrow("rollback certification");
    expect(await links()).toEqual(expected);
    expect(await projection()).toBe("old new");
    const preMove = await store.capture(documentId);
    if (!preMove) throw new Error("Missing location cut");
    const folderId = randomUUID();
    await runInDrizzleTransaction(db, async () => {
      await currentDrizzleDb(db)
        .insert(folders)
        .values({ id: folderId, contextSourceId: sourceId, name: "moved" });
      await currentDrizzleDb(db)
        .update(documents)
        .set({ folderId })
        .where(eq(documents.id, documentId));
      await recordDocumentMove(
        db,
        sourceId,
        sourceId,
        [{ id: documentId, path: "/chapter.md", kind: "file" }],
        "/chapter.md",
        "/moved/chapter.md",
      );
    });
    expect(await store.certify(preMove, { markdown: "wrong folder", links: [] }, new Date())).toBe(
      false,
    );
    expect(await store.stale({ projectId })).toEqual([documentId]);
    await service.flush({ projectId });
    expect(await store.stale({ projectId })).toEqual([]);
    const [watermark] = await db
      .select()
      .from(documentDerivations)
      .where(eq(documentDerivations.documentId, documentId));
    expect(await projection()).toBe("old new");
    expect(await links()).toEqual([{ ...expected[0], targetKey: "manuscript://moved/next.md" }]);
    expect(watermark?.linksLocationVersion).toBe(1n);
    expect(watermark?.linksExtractorVersion).toBe(2);
    await db
      .update(documentDerivations)
      .set({ linksExtractorVersion: 1 })
      .where(eq(documentDerivations.documentId, documentId));
    expect(await store.stale({ projectId })).toEqual([documentId]);
    await service.flush({ projectId });
    expect(await store.stale({ projectId })).toEqual([]);
    doc.destroy();
  });

  it("rolls back rejected certification and failed consumption without publishing", async () => {
    const doc = new Y.Doc({ gc: false });
    const paragraph = new Y.XmlElement("paragraph");
    doc.getXmlFragment("prosemirror").push([paragraph]);
    const text = new Y.XmlText();
    paragraph.push([text]);
    text.insert(0, "next", { link: { href: "next.md" } });
    await append(doc, "before");
    await service.derive(documentId);
    const beforeRows = await db.select().from(documentYjsUpdates);
    const beforeLinks = await links();
    const beforeWatermarks = await db.select().from(documentDerivations);
    let publications = 0;
    const rewrite = createDrizzleDocumentLinkRewrite({
      db,
      resolveUri: (tx, id) =>
        resolveDocumentUri(tx, createDrizzleProjectWorkAuthorityResolver(db), id),
      serializer: { serializeDocument: async () => "rewritten" },
      publish: () => {
        publications++;
      },
    });
    for (const rejection of [false, true]) {
      await expect(
        rewrite({
          documentId,
          claim: async () => {
            // Change the locked cut to force a real certification rejection.
            if (rejection)
              await currentDrizzleDb(db)
                .update(documents)
                .set({ locationVersion: 1n })
                .where(eq(documents.id, documentId));
            return {
              substitutions: new Map([["next.md", { href: "renamed.md" }]]),
              mover: { type: "user", actorUserId: userId },
              consume: async () => {
                throw new Error("consume failed");
              },
            };
          },
        }),
      ).rejects.toThrow(rejection ? "certification rejected" : "consume failed");
      expect(await db.select().from(documentYjsUpdates)).toEqual(beforeRows);
      expect(await links()).toEqual(beforeLinks);
      expect(await db.select().from(documentDerivations)).toEqual(beforeWatermarks);
      expect(await projection()).toBe("before");
      expect(publications).toBe(0);
    }
    doc.destroy();
  });

  it("reconstructs only the restored generation, even with retained retired updates and a later retired checkpoint", async () => {
    const doc = new Y.Doc({ gc: false });
    const original = await append(doc, "Original ");
    await persistence.journal.checkpoint(documentId, Y.encodeStateAsUpdate(doc), original);
    await persistence.journal.compact(documentId, new Date(Date.now() + 1000));
    doc.getText("prose").delete(0, doc.getText("prose").length);
    const admission = await append(doc, "Before typing.");
    await persistence.journal.checkpoint(documentId, Y.encodeStateAsUpdate(doc), admission);
    const [checkpoint] = await db
      .select()
      .from(documentYjsCheckpoints)
      .where(eq(documentYjsCheckpoints.upToSeq, admission));
    if (!checkpoint) throw new Error("Missing retained checkpoint");
    const retiredSeq = await append(doc, " After writer typing.");
    await service.derive(documentId);
    expect(await projection()).toBe("Before typing. After writer typing.");
    const replaced = await replaceDocumentAuthorityHeadGeneration(db, {
      documentId,
      checkpointId: checkpoint.id,
      expectedGeneration: 1n,
    });
    if (!replaced.ok) throw new Error("Restore failed");
    // Force the late old-room insert after replacement, without timers or races.
    await db.insert(documentYjsCheckpoints).values({
      documentId,
      authorityId: checkpoint.authorityId,
      authorityGeneration: checkpoint.authorityGeneration,
      attributionManifest: checkpoint.attributionManifest,
      state: Buffer.from(Y.encodeStateAsUpdate(doc)),
      stateVector: Buffer.from(Y.encodeStateVector(doc)),
      upToSeq: admission,
      reason: "retired room",
    });
    await service.derive(documentId);
    expect(await projection()).toBe("Before typing.");
    for (const snapshot of [
      await persistence.journal.readForReconstruction(documentId),
      await persistence.journal.read(documentId, { until: retiredSeq }),
    ]) {
      const reconstructed = new Y.Doc({ gc: false });
      if (snapshot.checkpoint) Y.applyUpdate(reconstructed, snapshot.checkpoint);
      for (const row of snapshot.updates) Y.applyUpdate(reconstructed, row.update);
      expect(reconstructed.getText("prose").toString()).toBe("Before typing.");
      reconstructed.destroy();
    }
    doc.destroy();
  });

  it("drops room and explicit checkpoints queued behind a generation replacement", async () => {
    const room = new Y.Doc({ gc: false });
    const beforeSeq = await append(room, "Before");
    await persistence.journal.checkpoint(documentId, Y.encodeStateAsUpdate(room), beforeSeq);
    const [saved] = await db
      .select()
      .from(documentYjsCheckpoints)
      .where(eq(documentYjsCheckpoints.upToSeq, beforeSeq));
    if (!saved) throw new Error("Missing saved checkpoint");
    await append(room, " After");
    bindDocumentAuthority(room, await ensureAndReadDocumentAuthorityHead(db, documentId));
    const hp = createHocuspocusPersistenceService({
      journal: persistence.journal,
      hocuspocus: () => null,
      latestUpdateSeq: persistence.store.latestUpdateSeq,
      metaForOrigin: () => ({ origin: `human:${userId}`, seq: 0 }),
      emitAgentEditInvariantViolation: () => undefined,
    });
    const explicit = createCheckpointService({
      coordinator: {
        withDocument: async (_id, operation) => operation(room),
        recover: async () => {},
      },
      store: persistence.store,
      latestUpdateSeq: persistence.store.latestUpdateSeq,
      markdownDocuments: {
        restoreFromYDoc: async () => {
          throw new Error("Not used");
        },
      },
    });
    let unlock = () => {};
    let signalLocked = () => {};
    const gate = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const blocker = db.transaction(async (tx) => {
      await lockDocumentMutation(tx, documentId);
      signalLocked();
      await gate;
    });
    await locked;
    async function waitForQueued(count: number) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const rows = await db.execute(sql`select count(*)::int as n from pg_locks
          where locktype = 'advisory' and not granted
          and database = (select oid from pg_database where datname = current_database())`);
        if (Number(rows[0]?.n) >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Expected ${count} queued mutation locks`);
    }
    const replacement = replaceDocumentAuthorityHeadGeneration(db, {
      documentId,
      checkpointId: saved.id,
      expectedGeneration: 1n,
    });
    let admission: ReturnType<typeof explicit.checkpoint> | undefined;
    try {
      await waitForQueued(1);
      await hp.storeHocuspocusDocument(documentId, room);
      await waitForQueued(2);
      admission = explicit.checkpoint(documentId, "queued explicit checkpoint");
      await waitForQueued(3);
    } finally {
      unlock();
      await blocker;
      await replacement;
      await hp.drainHocuspocusPersistence();
    }
    expect
      .soft(await admission)
      .toEqual({ ok: false, error: { code: "stale_generation", documentId } });
    expect(
      await db
        .select()
        .from(documentYjsCheckpoints)
        .where(eq(documentYjsCheckpoints.documentId, documentId)),
    ).toHaveLength(2);
    await service.derive(documentId);
    expect(await projection()).toBe("Before");
    room.destroy();
  });

  it("never stamps an acquired old handle with the generation restored before capture", async () => {
    const room = new Y.Doc({ gc: false });
    const beforeSeq = await append(room, "Before");
    await persistence.journal.checkpoint(documentId, Y.encodeStateAsUpdate(room), beforeSeq);
    const [saved] = await persistence.store.listCheckpoints(documentId);
    if (!saved) throw new Error("Missing checkpoint");
    await append(room, " After");
    let acquired = () => {};
    let resume = () => {};
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const coordinator = createHocuspocusCoordinatorForTest({
      journal: persistence.journal,
      hocuspocus: () => ({ documents: new Map([[documentId, room]]) }) as never,
      openLiveDoc: async () => ({ doc: room, release: async () => {} }),
    });
    const explicit = createCheckpointService({
      coordinator: {
        ...coordinator,
        withDocument: (id, operation) =>
          coordinator.withDocument(id, async (doc) => {
            acquired();
            await paused;
            return operation(doc);
          }),
      },
      store: persistence.store,
      latestUpdateSeq: persistence.store.latestUpdateSeq,
      markdownDocuments: {
        restoreFromYDoc: async () => {
          throw new Error("Not used");
        },
      },
    });
    const admission = explicit.checkpoint(documentId, "pre-capture restore");
    await ready;
    try {
      await replaceDocumentAuthorityHeadGeneration(db, {
        documentId,
        checkpointId: Number(saved.id),
        expectedGeneration: 1n,
      });
    } finally {
      resume();
    }
    expect
      .soft(await admission)
      .toEqual({ ok: false, error: { code: "stale_generation", documentId } });
    const checkpoints = await db
      .select()
      .from(documentYjsCheckpoints)
      .where(eq(documentYjsCheckpoints.documentId, documentId));
    expect.soft(checkpoints.filter((row) => row.authorityGeneration === 2n)).toHaveLength(1);
    await service.derive(documentId);
    expect(await projection()).toBe("Before");
    room.destroy();
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
