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
import { createHocuspocusPersistenceService } from "../hocuspocus-persistence.js";
import {
  ensureAndReadDocumentAuthorityHead,
  replaceDocumentAuthorityHeadGeneration,
} from "./drizzle-document-authority-head.js";
import { createDrizzleDocumentDerivationStore } from "./drizzle-document-derivations.js";
import { createDrizzleDocumentLinkRewrite } from "./drizzle-document-link-rewrite.js";
import { lockDocumentMutation } from "./drizzle-document-mutation-lock.js";
import { createDrizzleCollabPersistence } from "./drizzle-journal.js";

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
  const failures: unknown[] = [];
  let fail = false;
  const service = createDocumentDerivationService({
    store,
    serializer: {
      async serializeDocument(_id, doc) {
        if (fail) throw new Error("serializer unavailable");
        return doc.getText("prose").toString();
      },
    },
    outsideTransaction: (operation) => operation(),
    failed: (_id, cause) => failures.push(cause),
  });

  beforeEach(async () => {
    await deleteDrizzleRows(db, [users]);
    fail = false;
    failures.length = 0;
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

  async function links() {
    return db
      .select({
        href: documentLinks.href,
        key: documentLinks.targetKey,
        project: documentLinks.targetProjectId,
        occurrences: documentLinks.occurrences,
      })
      .from(documentLinks)
      .where(eq(documentLinks.sourceDocumentId, documentId));
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
      { href: "next.md", key: "manuscript://next.md", project: projectId, occurrences: 1 },
    ];
    expect(await links()).toEqual(expected);
    expect(await store.certify(oldCut, { markdown: "old", links: [] }, new Date())).toBe(false);
    expect(await links()).toEqual(expected);
    await expect(
      runInDrizzleTransaction(db, async () => {
        await append(doc, " rolled back");
        text.format(0, text.length, { link: { href: "wrong.md" } });
        await persistence.journal.append(documentId, Y.encodeStateAsUpdate(doc), {
          origin: `human:${userId}`,
          seq: 0,
        });
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
    expect(watermark?.projectionLocationVersion).toBe(1n);
    expect(await projection()).toBe("old new");
    expect(await links()).toEqual([{ ...expected[0], key: "manuscript://moved/next.md" }]);
    expect(watermark?.linksLocationVersion).toBe(1n);
    expect(watermark?.linksExtractorVersion).toBe(2);
    await db.update(documents).set({ kind: "manifest" }).where(eq(documents.id, documentId));
    await db
      .update(documentDerivations)
      .set({ linksExtractorVersion: 1 })
      .where(eq(documentDerivations.documentId, documentId));
    await service.derive(documentId);
    expect(await links()).toEqual([]);
    expect(await projection()).toBe("old new");
    doc.destroy();
  });

  it("rolls back rejected certification and failed consumption without publishing, and skips a null claim", async () => {
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
    let consumes = 0;
    const rewrite = createDrizzleDocumentLinkRewrite({
      db,
      resolveUri: (tx, id) =>
        resolveDocumentUri(tx, createDrizzleProjectWorkAuthorityResolver(db), id),
      serializer: { serializeDocument: async () => "rewritten" },
      publish: () => {
        publications++;
      },
    });
    const claimed = {
      substitutions: new Map([
        ["next.md", { href: "renamed.md", oldFilename: "next.md", newFilename: "renamed.md" }],
      ]),
      mover: { type: "user" as const, actorUserId: userId },
      consume: async () => {
        consumes++;
        throw new Error("consume failed");
      },
    };
    await expect(rewrite({ documentId, claim: async () => claimed })).rejects.toThrow(
      "consume failed",
    );
    expect(consumes).toBe(1);
    // Force the real CAS to reject using a location change inside the claim transaction.
    await expect(
      rewrite({
        documentId,
        claim: async () => {
          await currentDrizzleDb(db)
            .update(documents)
            .set({ locationVersion: 1n })
            .where(eq(documents.id, documentId));
          return claimed;
        },
      }),
    ).rejects.toThrow("certification rejected");
    expect(consumes).toBe(1);
    await rewrite({ documentId, claim: async () => null });
    expect(await db.select().from(documentYjsUpdates)).toEqual(beforeRows);
    expect(await links()).toEqual(beforeLinks);
    expect(await db.select().from(documentDerivations)).toEqual(beforeWatermarks);
    expect(await projection()).toBe("before");
    expect(publications).toBe(0);
    doc.destroy();
  });

  it("rebuilds documents certified by extractor version 1", async () => {
    const doc = new Y.Doc();
    await append(doc, "existing");
    await service.derive(documentId);
    await db
      .update(documentDerivations)
      .set({ projectionExtractorVersion: 1, linksExtractorVersion: 1 })
      .where(eq(documentDerivations.documentId, documentId));
    expect(await store.stale({ projectId })).toEqual([documentId]);
    await service.flush({ projectId });
    expect(await store.stale({ projectId })).toEqual([]);
    const [watermark] = await db
      .select()
      .from(documentDerivations)
      .where(eq(documentDerivations.documentId, documentId));
    expect(watermark?.projectionExtractorVersion).toBe(2);
    expect(watermark?.linksExtractorVersion).toBe(2);
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
    expect(replaced.ok).toBe(true);
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
      expect(snapshot.updates).toEqual([]);
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
    const readCheckpointAuthority = (id: string) => ensureAndReadDocumentAuthorityHead(db, id);
    const hp = createHocuspocusPersistenceService({
      journal: persistence.journal,
      readCheckpointAuthority,
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
      readCheckpointAuthority,
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
    const checkpoints = await db
      .select()
      .from(documentYjsCheckpoints)
      .where(eq(documentYjsCheckpoints.documentId, documentId));
    expect.soft(checkpoints).toHaveLength(2);
    expect.soft(checkpoints.filter((row) => row.authorityGeneration === 2n)).toHaveLength(1);
    await service.derive(documentId);
    expect(await projection()).toBe("Before");
    room.destroy();
  });

  it("heals failed derives and generation replacement from database state, including another instance's writes", async () => {
    const doc = new Y.Doc({ gc: false });
    const admission = await append(doc, "checkpoint");
    await persistence.journal.checkpoint(documentId, Y.encodeStateAsUpdate(doc), admission);
    const [checkpoint] = await db
      .select()
      .from(documentYjsCheckpoints)
      .where(eq(documentYjsCheckpoints.documentId, documentId));
    if (!checkpoint) throw new Error("Missing retained checkpoint");
    await service.derive(documentId);
    // Independent adapter admission, deliberately bypassing this service's timers.
    const remote = createDrizzleCollabPersistence(db);
    doc.getText("prose").insert(doc.getText("prose").length, " remote typing");
    await remote.journal.append(documentId, Y.encodeStateAsUpdate(doc), {
      origin: `human:${userId}`,
      seq: 0,
    });
    fail = true;
    await service.flush({ projectId, personalOwnerId: userId });
    expect(failures).toHaveLength(1);
    expect(await projection()).toBe("checkpoint");
    expect(await store.stale({ projectId })).toEqual([documentId]);
    fail = false;
    expect(await service.sweep()).toBe(1);
    expect(await projection()).toBe("checkpoint remote typing");
    const replaced = await replaceDocumentAuthorityHeadGeneration(db, {
      documentId,
      checkpointId: checkpoint.id,
      expectedGeneration: 1n,
    });
    expect(replaced.ok).toBe(true);
    await service.flush({ projectId });
    expect(await projection()).toBe("checkpoint");
    const [watermark] = await db
      .select()
      .from(documentDerivations)
      .where(eq(documentDerivations.documentId, documentId));
    expect(watermark?.projectionGeneration).toBe(2n);
    expect(watermark?.projectionAdmissionSequence).toBe(1n);
    doc.destroy();
  });
});
