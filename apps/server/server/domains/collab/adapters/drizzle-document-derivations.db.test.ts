/** PostgreSQL races and recovery contracts for durable document derivation. */
import { randomUUID } from "node:crypto";
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documentDerivations,
  documents,
  documentYjsCheckpoints,
  projects,
  users,
} from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { deleteDrizzleRows } from "../../../test-support/drizzle-reset.js";
import { recordDocumentMove } from "../../context/adapters/context-fs/document-locations.js";
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
  const store = createDrizzleDocumentDerivationStore(db);
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
    const before = Y.encodeStateVector(doc);
    doc.getText("prose").insert(doc.getText("prose").length, text);
    return persistence.journal.append(documentId, Y.encodeStateAsUpdate(doc, before), {
      origin: `human:${userId}`,
      seq: 0,
    });
  }
  async function projection() {
    const [row] = await db.select().from(documents).where(eq(documents.id, documentId));
    return row?.markdownProjection;
  }

  it("rejects an older admission and an old-location cut without overwriting the newer projection", async () => {
    const doc = new Y.Doc({ gc: false });
    await append(doc, "old");
    const oldCut = await store.capture(documentId);
    if (!oldCut) throw new Error("Missing old cut");
    await append(doc, " new");
    await service.derive(documentId);
    expect(await store.certify(oldCut, { markdown: "old" }, new Date())).toBe(false);
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
    expect(await store.certify(preMove, { markdown: "wrong folder" }, new Date())).toBe(false);
    expect(await store.stale({ projectId })).toEqual([documentId]);
    await service.flush({ projectId });
    expect(await store.stale({ projectId })).toEqual([]);
    const [watermark] = await db
      .select()
      .from(documentDerivations)
      .where(eq(documentDerivations.documentId, documentId));
    expect(watermark?.projectionLocationVersion).toBe(1n);
    expect(await projection()).toBe("old new");
    doc.destroy();
  });

  it("keeps restored content when a retired room inserts a later checkpoint", async () => {
    const doc = new Y.Doc({ gc: false });
    const admission = await append(doc, "Before typing.");
    await persistence.journal.checkpoint(documentId, Y.encodeStateAsUpdate(doc), admission);
    const [checkpoint] = await db
      .select()
      .from(documentYjsCheckpoints)
      .where(eq(documentYjsCheckpoints.documentId, documentId));
    if (!checkpoint) throw new Error("Missing retained checkpoint");
    await append(doc, " After writer typing.");
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
