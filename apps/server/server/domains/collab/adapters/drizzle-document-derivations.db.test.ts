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
  folders,
  projects,
  users,
} from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { deleteDrizzleRows } from "../../../test-support/drizzle-reset.js";
import { recordDocumentMove } from "../../context/adapters/context-fs/document-locations.js";
import { resolveDocumentUri } from "../../context/document-uri-resolver.js";
import { createDrizzleProjectWorkAuthorityResolver } from "../../projects/index.js";
import { createDocumentDerivationService } from "../domain/document-derivations.js";
import { replaceDocumentAuthorityHeadGeneration } from "./drizzle-document-authority-head.js";
import { createDrizzleDocumentDerivationStore } from "./drizzle-document-derivations.js";
import { createDrizzleCollabPersistence } from "./drizzle-journal.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DB suites require DATABASE_URL");

describe("durable document derivations", () => {
  const db = createDb(DATABASE_URL, { max: 4 });
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
