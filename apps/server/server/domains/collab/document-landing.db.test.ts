/** PostgreSQL proofs for seed-only admission and rollback-safe fill/prepend publication. */
import { randomUUID } from "node:crypto";
import { fragmentOf, toDocHandle, yProsemirrorModel } from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts/runtime";
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import { contextSources, documents, projects, users } from "@meridian/database/schema";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema, createCollabYDoc } from "@meridian/prosemirror-schema";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  deferUntilDrizzleCommit,
  runInDrizzleTransaction,
} from "../../shared/drizzle-transaction.js";
import { deleteDrizzleRows } from "../../test-support/drizzle-reset.js";
import { createDrizzleCollabPersistence } from "./adapters/drizzle-journal.js";
import { createInMemoryCoordinator } from "./adapters/in-memory/agent-edit.js";
import { createStaticDocumentLinkScopes } from "./adapters/in-memory/static-document-link-scopes.js";
import { createLinkBinder } from "./domain/link-binding.js";
import { createMarkdownDocumentEngine } from "./domain/markdown-document.js";

const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
describe.skipIf(!enabled || !process.env.DATABASE_URL)("document landing (postgres)", () => {
  const db = createDb(process.env.DATABASE_URL ?? "postgres://unused", { max: 4 });
  const schema = buildDocumentSchema();
  const codec = mdxCodec({ schema });
  const model = yProsemirrorModel(schema);
  let documentId: DocumentId;
  let subject: ReturnType<typeof setup>;
  function setup() {
    const persistence = createDrizzleCollabPersistence(db);
    const coordinator = createInMemoryCoordinator(persistence.journal);
    const links = createStaticDocumentLinkScopes();
    const engine = createMarkdownDocumentEngine({
      exportCodec: mdxCodec({ schema, export: true }),
      codec,
      model,
      coordinator,
      links,
      journal: persistence.journal,
      landingJournal: persistence.journal,
      lifecycle: persistence.lifecycle,
      initialDocumentSeeds: persistence.lifecycle,
      deferUntilCommit: deferUntilDrizzleCommit,
      metaForOrigin: () => ({ origin: "system", seq: 0 }),
      identityPreservingWrite: async () => {
        throw new Error("not used");
      },
      resolveFiletype: async () => "markdown",
    });
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
  afterAll(async () => {
    await deleteDrizzleRows(db, [users]);
    await db.close();
  });

  it("publishes only after ambient commit, and rolls back without touching the room", async () => {
    const content = await subject.bind("arrived");
    await expect(
      runInDrizzleTransaction(db, async () => {
        expect(await subject.engine.fillEmptyDocument(documentId, content)).toMatchObject({
          ok: true,
          value: { updateSeq: expect.any(Number) },
        });
        expect(await subject.engine.readAsMarkdown(documentId)).toEqual({ ok: true, value: "" });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect((await subject.journal.read(documentId)).updates).toHaveLength(0);
    expect(await subject.engine.readAsMarkdown(documentId)).toEqual({ ok: true, value: "" });
    await runInDrizzleTransaction(db, async () => {
      await subject.engine.fillEmptyDocument(documentId, content);
      expect(await subject.engine.readAsMarkdown(documentId)).toEqual({ ok: true, value: "" });
    });
    expect(await subject.engine.readAsMarkdown(documentId)).toEqual({
      ok: true,
      value: "arrived\n",
    });
    expect(await subject.engine.fillEmptyDocument(documentId, content)).toEqual({
      ok: true,
      value: null,
    });
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

  it("prepend joins the ambient rollback and publishes only on commit", async () => {
    await subject.engine.fillEmptyDocument(documentId, await subject.bind("kept"));
    const bound = await subject.bind("above");
    await expect(
      runInDrizzleTransaction(db, async () => {
        await subject.engine.prependBlocks(documentId, bound);
        expect(await subject.engine.readAsMarkdown(documentId)).toEqual({
          ok: true,
          value: "kept\n",
        });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await subject.engine.readAsMarkdown(documentId)).toEqual({ ok: true, value: "kept\n" });
    await runInDrizzleTransaction(db, async () => {
      await subject.engine.prependBlocks(documentId, bound);
      expect(await subject.engine.readAsMarkdown(documentId)).toEqual({
        ok: true,
        value: "kept\n",
      });
    });
    expect(await subject.engine.readAsMarkdown(documentId)).toEqual({
      ok: true,
      value: "above\n\nkept\n",
    });
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
