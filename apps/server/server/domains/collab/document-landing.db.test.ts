/** PostgreSQL proofs for seed-only admission and rollback-safe fill/prepend publication. */

import { randomUUID } from "node:crypto";
import { Hocuspocus } from "@hocuspocus/server";
import { fragmentOf, toDocHandle, yProsemirrorModel } from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts/runtime";
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import { contextSources, documents, projects, users } from "@meridian/database/schema";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema, createCollabYDoc } from "@meridian/prosemirror-schema";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { runInDrizzleTransaction } from "../../shared/drizzle-transaction.js";
import { deleteDrizzleRows } from "../../test-support/drizzle-reset.js";
import { createTestWorkProjectionMutation } from "../../test-support/work-projection.js";
import { createAllowAllFileAccess } from "../file-policy/index.js";
import { loadDocumentState } from "./adapters/document-loader.js";
import { createDrizzleCollabPersistence } from "./adapters/drizzle-journal.js";
import { createHocuspocusCoordinator } from "./adapters/hocuspocus-coordinator.js";
import { createStaticDocumentLinkScopes } from "./adapters/in-memory/static-document-link-scopes.js";
import { createCollabDomain } from "./composition.js";
import { createLinkBinder } from "./domain/link-binding.js";

const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
describe.skipIf(!enabled || !process.env.DATABASE_URL)("document landing (postgres)", () => {
  const db = createDb(process.env.DATABASE_URL ?? "postgres://unused", { max: 4 });
  const schema = buildDocumentSchema();
  const codec = mdxCodec({ schema });
  const model = yProsemirrorModel(schema);
  let documentId: DocumentId;
  let subject: ReturnType<typeof setup>;
  const rooms: Hocuspocus[] = [];
  const domains: ReturnType<typeof createCollabDomain>[] = [];
  function setup() {
    const persistence = createDrizzleCollabPersistence(db);
    const hp = new Hocuspocus({
      yDocOptions: { gc: false, gcFilter: () => true },
      onLoadDocument: async ({ documentName, document }) => {
        const state = await loadDocumentState(persistence.journal, documentName, document);
        if (state) Y.applyUpdate(document, state);
      },
    });
    rooms.push(hp);
    const coordinator = createHocuspocusCoordinator({
      journal: persistence.journal,
      hocuspocus: () => hp,
    });
    const links = createStaticDocumentLinkScopes();
    const engine = createCollabDomain({
      db,
      links,
      aheadRefs: { register: async () => {} },
      fileAccess: createAllowAllFileAccess(),
      workProjectionMutation: createTestWorkProjectionMutation(db),
    });
    engine.bindHocuspocus(hp);
    domains.push(engine);
    const binder = createLinkBinder({
      codec,
      schema,
      model,
      coordinator,
      links,
      registrar: { register: async () => {} },
      resolveFiletype: async () => "markdown",
      inTransaction: () => false,
    });
    return {
      engine,
      persistence,
      hp,
      coordinator,
      journal: persistence.journal,
      bind: (markdown: string) => binder.bindMarkdown({ holder: { documentId }, markdown }),
    };
  }
  beforeEach(async () => {
    await deleteDrizzleRows(db, [users]);
    const user = randomUUID(),
      project = randomUUID(),
      source = randomUUID();
    documentId = randomUUID() as DocumentId;
    await db.insert(users).values(conformanceUserValues(user, "document-landing"));
    await db
      .insert(projects)
      .values({ id: project, userId: user, name: "Landing", slug: "landing" });
    await db
      .insert(contextSources)
      .values({ id: source, projectId: project, name: "KB", slug: "kb" });
    await db.insert(documents).values({
      id: documentId,
      contextSourceId: source,
      name: "placeholder",
      fileType: "markdown",
    });
    subject = setup();
    await subject.engine.seedFromMarkdown(documentId, await subject.bind(""), { type: "system" });
  });
  // Each case owns its rooms and domains: drain and dispose before the next destructive reset.
  afterEach(async () => {
    for (const hp of rooms.splice(0)) {
      hp.closeConnections();
      for (const doc of [...hp.documents.values()]) await hp.unloadDocument(doc);
    }
    for (const domain of domains.splice(0)) {
      await domain.drainHocuspocusPersistence();
      domain.dispose();
    }
  });
  afterAll(async () => {
    await deleteDrizzleRows(db, [users]);
    await db.close();
  });

  it.each(
    (["fill", "prepend"] as const).flatMap((door) =>
      [false, true].flatMap((warm) =>
        [false, true].flatMap((read) =>
          [false, true].map((commit) => ({ door, warm, read, commit })),
        ),
      ),
    ),
  )("$door landing warm=$warm read=$read commit=$commit never publishes before commit", async ({
    door,
    warm,
    read,
    commit,
  }) => {
    if (door === "prepend")
      await subject.engine.fillEmptyDocument(documentId, await subject.bind("kept"));
    const kept = door === "prepend" ? "kept\n" : "";
    // A fresh room adapter avoids retaining the seed/fill operation's direct connection.
    subject = setup();
    const observer = warm ? await subject.hp.openDirectConnection(documentId) : null;
    if (warm) await subject.engine.readAsMarkdown(documentId);
    const content = await subject.bind("arrived");
    const land = async () => {
      const result =
        door === "fill"
          ? await subject.engine.fillEmptyDocument(documentId, content)
          : await subject.engine.prependBlocks(documentId, content);
      expect(result).toMatchObject({ ok: true, value: { updateSeq: expect.any(Number) } });
      if (read)
        expect(await subject.engine.readAsMarkdown(documentId)).toEqual({ ok: true, value: kept });
      // Public reads may use private copies, never open or hydrate a shared cold room.
      expect(subject.hp.documents.has(documentId)).toBe(warm);
      const room = subject.hp.documents.get(documentId);
      if (room)
        expect(
          codec.serialize(
            model.projectBlocks(toDocHandle(room)),
            createStaticDocumentLinkScopes().reader({ uri: null, view: { kind: "live" } }),
          ),
        ).toBe(kept);
      if (!commit) throw new Error("rollback");
    };
    try {
      if (commit) await runInDrizzleTransaction(db, land);
      else await expect(runInDrizzleTransaction(db, land)).rejects.toThrow("rollback");
      expect((await subject.journal.read(documentId)).updates).toHaveLength(
        (door === "prepend" ? 1 : 0) + (commit ? 1 : 0),
      );
      const expected = commit ? (door === "prepend" ? "arrived\n\nkept\n" : "arrived\n") : kept;
      expect(await subject.engine.readAsMarkdown(documentId)).toEqual({
        ok: true,
        value: expected,
      });
      const newcomer = await subject.hp.openDirectConnection(documentId);
      try {
        if (!newcomer.document) throw new Error("missing observer document");
        expect(
          codec.serialize(
            model.projectBlocks(toDocHandle(newcomer.document)),
            createStaticDocumentLinkScopes().reader({ uri: null, view: { kind: "live" } }),
          ),
        ).toBe(expected);
      } finally {
        await newcomer.disconnect();
      }
    } finally {
      await observer?.disconnect();
    }
  });

  it.each([
    "writer content",
    "",
  ])("restore of %j never renews seed-only eligibility after writer admission", async (restoredText) => {
    const client = createCollabYDoc({ gc: false });
    const seed = await subject.journal.read(documentId);
    if (seed.checkpoint) Y.applyUpdate(client, seed.checkpoint);
    const checkpointService = subject.engine;
    const before = Y.encodeStateVector(client);
    client.transact(() => {
      const fragment = fragmentOf(client);
      if (fragment.length) fragment.delete(0, fragment.length);
      model.insertBlocks(toDocHandle(client), null, {
        blocks: codec.parse("writer content").blocks,
      });
    });
    await subject.journal.appendWriterUpdate?.(
      documentId,
      Y.encodeStateAsUpdate(client, before),
      { origin: "system", seq: 0 },
      seed.authority,
    );
    await subject.coordinator.recover(documentId);
    const writerCheckpoint = await checkpointService.checkpoint(documentId, "writer");
    expect(writerCheckpoint.ok).toBe(true);
    if (!restoredText) {
      const beforeDelete = Y.encodeStateVector(client);
      fragmentOf(client).delete(0, fragmentOf(client).length);
      await subject.journal.appendWriterUpdate?.(
        documentId,
        Y.encodeStateAsUpdate(client, beforeDelete),
        { origin: "system", seq: 0 },
        seed.authority,
      );
      await subject.coordinator.recover(documentId);
    }
    const checkpoint = restoredText
      ? writerCheckpoint
      : await checkpointService.checkpoint(documentId, "empty after edit");
    if (!checkpoint.ok) throw new Error("checkpoint failed");
    expect(await checkpointService.restore(documentId, checkpoint.value)).toEqual({
      ok: true,
      value: undefined,
    });
    subject = setup(); // Restore retires the old room; readers acquire the replacement generation.
    expect(
      await subject.engine.fillEmptyDocument(documentId, await subject.bind("imported")),
    ).toEqual({
      ok: true,
      value: null,
    });
    expect(await subject.engine.readAsMarkdown(documentId)).toEqual({
      ok: true,
      value: restoredText ? `${restoredText}\n` : "",
    });
    client.destroy();
  });

  it("admits only one of two concurrent fills", async () => {
    const bound = await subject.bind("once");
    const results = await Promise.all([
      subject.engine.fillEmptyDocument(documentId, bound),
      subject.engine.fillEmptyDocument(documentId, bound),
    ]);
    expect(results.filter((result) => result.ok && result.value !== null)).toHaveLength(1);
    expect((await subject.journal.read(documentId)).updates).toHaveLength(1);
    expect(await subject.engine.readAsMarkdown(documentId)).toEqual({ ok: true, value: "once\n" });
  });

  it("socket journal admission prevents fill even after compaction, and prepend retains the writer node", async () => {
    const client = createCollabYDoc({ gc: false });
    const snapshot = await subject.journal.read(documentId);
    if (snapshot.checkpoint) Y.applyUpdate(client, snapshot.checkpoint);
    const before = Y.encodeStateVector(client);
    client.transact(() => {
      const fragment = fragmentOf(client);
      if (fragment.length) fragment.delete(0, fragment.length);
      model.insertBlocks(toDocHandle(client), null, { blocks: codec.parse("k").blocks });
    });
    await subject.journal.appendWriterUpdate?.(
      documentId,
      Y.encodeStateAsUpdate(client, before),
      { origin: "system", seq: 0 },
      snapshot.authority,
    );
    await subject.coordinator.recover(documentId);
    await subject.journal.compact(documentId, new Date(Date.now() + 1000));
    const content = await subject.bind("imported");
    expect(await subject.engine.fillEmptyDocument(documentId, content)).toEqual({
      ok: true,
      value: null,
    });
    const writerNode = fragmentOf(client).get(0);
    await subject.engine.prependBlocks(documentId, content);
    const landed = await subject.journal.read(documentId);
    if (landed.checkpoint) Y.applyUpdate(client, landed.checkpoint);
    for (const row of landed.updates) Y.applyUpdate(client, row.update);
    expect(fragmentOf(client).get(1)).toBe(writerNode);
    expect(await subject.engine.readAsMarkdown(documentId)).toEqual({
      ok: true,
      value: "imported\n\nk\n",
    });
    client.destroy();
  });
});
