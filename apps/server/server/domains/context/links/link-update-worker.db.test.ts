/** Production-composed move maintenance, lifecycle recovery, and real write-failure backoff. */
import { randomUUID } from "node:crypto";
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documents,
  documentYjsUpdates,
  linkRedirects,
  projects,
  users,
  works,
} from "@meridian/database/schema";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  type AppServices,
  composeAppServices,
  createProductionAppPorts,
} from "../../../lib/compose.js";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { deleteDrizzleRows } from "../../../test-support/drizzle-reset.js";
import { createDrizzleCollabPersistence } from "../../collab/adapters/drizzle-journal.js";
import { createNoopEventSink } from "../../observability/index.js";
import { DrizzleContextTreeMutationStore } from "../adapters/context-fs/drizzle-tree-mutation-store.js";
import type { ContextPort } from "../index.js";
import { createLinkUpdateWorker } from "./link-update-worker.js";

const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
describe.skipIf(!enabled || !process.env.DATABASE_URL)("link update worker (postgres)", () => {
  const db = createDb(process.env.DATABASE_URL ?? "postgres://unused", { max: 4 });
  const userId = randomUUID();
  const projectId = randomUUID();
  const workId = randomUUID();
  const sourceId = randomUUID();
  let app: AppServices;
  let port: ContextPort;
  beforeEach(async () => {
    await deleteDrizzleRows(db, [users]);
    await db.insert(users).values(conformanceUserValues(userId, "link-worker"));
    await db.insert(projects).values({ id: projectId, userId, name: "Links", slug: "links" });
    await db.insert(works).values([
      { projectId, createdByUserId: userId, name: "No Work", isNoWork: true },
      { id: workId, projectId, createdByUserId: userId, name: "Draft", slug: "draft" },
    ]);
    await db.insert(contextSources).values([
      {
        id: sourceId,
        projectId,
        name: "Manuscript",
        slug: "manuscript",
        scope: "project",
        isPrimary: true,
      },
      { workId, name: "Scratch", slug: "scratch", scope: "work" },
    ]);
    const ports = await createProductionAppPorts({
      db,
      eventSink: createNoopEventSink(),
      environment: { OPENAI_API_KEY: "sk-test-link-worker" },
    });
    app = composeAppServices(ports);
    const authority = await ports.workAuthorityResolver.byId(projectId, workId);
    if (!authority?.workSlug) throw new Error("Fixture Work missing");
    port = app.contextPorts.forProject(
      projectId,
      userId,
      new Map([[authority.workSlug, authority]]),
    );
  });
  afterEach(async () => {
    await app?.shutdown();
    await db.execute(sql`DROP TRIGGER IF EXISTS p5w_rewrite_failure ON documents`);
    await db.execute(sql`DROP FUNCTION IF EXISTS p5w_rewrite_failure()`);
  });
  afterAll(() => db.close());

  async function create(uri: string, content = "Target.", context = port) {
    const result = await context.createTrackedDocument(uri, content);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return result.value.documentId;
  }
  async function projection(id: string) {
    const [row] = await db.select().from(documents).where(eq(documents.id, id));
    return row?.markdownProjection;
  }
  it("defers a whole renumber batch until its deleted target is restored", async () => {
    const a = await create("manuscript://ch6.md");
    await port.createTrackedDocument("manuscript://ch5.md", "B.");
    const holder = await create(
      "scratch://@draft/holder.md",
      "[A](manuscript://ch6.md) and [B](manuscript://ch5.md).",
    );
    const before = await projection(holder);
    await db.update(works).set({ archivedAt: new Date() }).where(eq(works.id, workId));
    expect(await port.move("manuscript://ch6.md", "manuscript://ch7.md")).toMatchObject({
      ok: true,
    });
    await app.linkUpdates.sweep();
    expect(await port.move("manuscript://ch5.md", "manuscript://ch6.md")).toMatchObject({
      ok: true,
    });
    await app.linkUpdates.sweep();
    expect(await db.select().from(linkRedirects)).toHaveLength(2);
    expect(await projection(holder)).toBe(before);
    await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, a));
    await db.update(works).set({ archivedAt: null }).where(eq(works.id, workId));
    expect(await app.linkUpdates.sweep()).toBe(0);
    expect(await projection(holder)).toBe(before);
    const pending = await db.select().from(linkRedirects);
    expect(pending).toHaveLength(2);
    expect(pending.every((row) => row.attempts === 0 && row.retryAfter === null)).toBe(true);
    await db.update(documents).set({ deletedAt: null }).where(eq(documents.id, a));
    expect(await app.linkUpdates.sweep()).toBe(1);
    expect(await projection(holder)).toBe(
      "[A](manuscript://ch7.md) and [B](manuscript://ch6.md).\n",
    );
    expect(await db.select().from(linkRedirects)).toEqual([]);
  });
  it("leaves a vacated personal link unresolved in another project", async () => {
    const projectB = randomUUID();
    await db.insert(projects).values({ id: projectB, userId, name: "Other", slug: "other" });
    await db
      .insert(works)
      .values({ projectId: projectB, createdByUserId: userId, name: "No Work", isNoWork: true });
    const other = app.contextPorts.forProject(projectB, userId, new Map());
    await create("user://cast.md");
    await create("kb://cast.md", "Unrelated.", other);
    const holder = await create("manuscript://holder.md", "[cast](user://cast.md).", other);
    const before = await projection(holder);
    expect(await port.move("user://cast.md", "kb://cast.md")).toMatchObject({ ok: true });
    await app.linkUpdates.sweep();
    expect(await projection(holder)).toBe(before);
    expect(await db.select().from(linkRedirects)).toEqual([]);
    expect(
      await app.documentLinks.resolve({
        projectId: projectB,
        userId,
        holder: { documentId: holder, href: "user://cast.md" },
        target: { kind: "scheme", uri: "user://cast.md" },
      }),
    ).toBeNull();
  });
  it("respells a holder moved to personal space as a contextual project URI", async () => {
    await create("manuscript://original.md");
    await create("user://original.md", "Unrelated personal.");
    const holder = await create("manuscript://moving-holder.md", "[original](original.md).");
    expect(
      await port.move("manuscript://moving-holder.md", "user://moving-holder.md"),
    ).toMatchObject({ ok: true });
    await app.linkUpdates.sweep();
    expect(await projection(holder)).toBe("[original](manuscript://original.md).\n");
    expect(await db.select().from(linkRedirects)).toEqual([]);
  });
  it("serializes an overwrite with a worker holding the victim of a committed redirect", async () => {
    await app.linkUpdates.stop();
    await port.createTrackedDocument("manuscript://a0.md", "A.");
    await create("manuscript://b.md", "[A](a0.md).");
    expect(await port.move("manuscript://a0.md", "manuscript://a.md")).toMatchObject({ ok: true });
    expect(await db.select().from(linkRedirects)).toHaveLength(1);
    let ready!: (pid: number) => void;
    const holding = new Promise<number>((resolve) => {
      ready = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = createLinkUpdateWorker({
      db,
      eventSink: createNoopEventSink(),
      rewriteDocumentLinks: (input) =>
        app.documentSync.rewriteDocumentLinks({
          ...input,
          claim: async (cut) => {
            const rows = await currentDrizzleDb(db).execute(sql`select pg_backend_pid() as pid`);
            ready(Number(rows[0]?.pid));
            await gate;
            return input.claim(cut);
          },
        }),
    });
    const tree = new DrizzleContextTreeMutationStore(db);
    const source = await tree.inspect(sourceId, "a.md");
    const victim = await tree.inspect(sourceId, "b.md");
    if (source?.kind !== "file" || victim?.kind !== "file") throw new Error("Missing move entries");
    const sweeping = worker.sweep();
    const pid = await holding;
    const moving = tree.commitMove({
      source,
      destinationSourceId: sourceId,
      destinationPath: "b.md",
      expectedTarget: { state: "occupied", token: victim },
      overwrite: true,
      destinationFiletype: "markdown",
      graduateProvisionalName: false,
      mover: { userId },
    });
    // Observe a real lock overlap, not a timing assumption. Before the fix the
    // move owns the redirect while waiting on B, closing a cycle on release.
    try {
      await expect
        .poll(async () => {
          const rows = await db.execute(sql`select exists (
          select 1 from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))
        ) as blocked`);
          return rows[0]?.blocked;
        })
        .toBe(true);
      release();
      expect(await moving).toMatchObject({ ok: true });
      expect(await sweeping).toBe(1);
      // The move captures a fresh a.md redirect after the worker consumed a0.md.
      // Its holder is now deleted, so that new redirect legitimately stays pending.
      expect(await db.select().from(linkRedirects)).toMatchObject([{ href: "a.md", attempts: 0 }]);
    } finally {
      release();
      await Promise.allSettled([moving, sweeping]);
      await worker.stop();
    }
  });
  it("journal insertion finishes while a move holds the holder row", async () => {
    const holder = randomUUID();
    await db
      .insert(documents)
      .values({ id: holder, contextSourceId: sourceId, name: "holder", extension: "md" });
    const journal = createDrizzleCollabPersistence(db);
    await journal.lifecycle.ensureDocument(holder);
    const tree = new DrizzleContextTreeMutationStore(db);
    const source = await tree.inspect(sourceId, "holder.md");
    if (source?.kind !== "file") throw new Error("Missing holder");
    let rowLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      rowLocked = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    tree.setBeforeDestructiveWrite(async () => {
      rowLocked();
      await gate;
    });
    const moving = tree.commitMove({
      source,
      destinationSourceId: sourceId,
      destinationPath: "moved-holder.md",
      expectedTarget: { state: "absent" },
      overwrite: false,
      destinationFiletype: "markdown",
      graduateProvisionalName: false,
      mover: { userId },
    });
    const doc = new Y.Doc();
    try {
      await locked;
      // The journal FK takes KEY SHARE on the holder. It must finish before
      // releasing the move's NO KEY UPDATE lock; FOR UPDATE would block it.
      await runInDrizzleTransaction(db, async () => {
        await currentDrizzleDb(db).execute(sql`SET LOCAL lock_timeout = '2s'`);
        await journal.journal.append(holder, Y.encodeStateAsUpdate(doc), {
          origin: `human:${userId}`,
          seq: 0,
        });
      });
    } finally {
      release();
      await Promise.allSettled([moving]);
      tree.setBeforeDestructiveWrite(null);
      doc.destroy();
    }
    expect(await moving).toMatchObject({ ok: true });
    expect(
      await db.select().from(documentYjsUpdates).where(eq(documentYjsUpdates.documentId, holder)),
    ).toHaveLength(1);
  });
  it("backs off a failing rewrite without losing content or redirects, then succeeds", async () => {
    await create("manuscript://prologue.md");
    await create("manuscript://chapter-1.md");
    const holder = await create(
      "manuscript://chapter-2.md",
      "[chapter-1.md](chapter-1.md), [prologue.md](prologue.md).",
    );
    const before = await projection(holder);
    await db.execute(
      sql.raw(`CREATE FUNCTION p5w_rewrite_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id = '${holder}' THEN RAISE EXCEPTION 'rewrite storage unavailable'; END IF; RETURN NEW; END $$`),
    );
    await db.execute(
      sql`CREATE TRIGGER p5w_rewrite_failure BEFORE UPDATE OF markdown_projection ON documents FOR EACH ROW EXECUTE FUNCTION p5w_rewrite_failure()`,
    );
    expect(await port.move("manuscript://chapter-1.md", "manuscript://the-gate.md")).toMatchObject({
      ok: true,
    });
    await app.linkUpdates.sweep();
    const [pending] = await db.select().from(linkRedirects);
    expect(pending?.attempts).toBe(1);
    expect(pending?.retryAfter?.getTime()).toBeGreaterThan(Date.now());
    expect(await projection(holder)).toBe(before);
    expect(await app.linkUpdates.sweep()).toBe(0);
    await db.execute(sql`DROP TRIGGER p5w_rewrite_failure ON documents`);
    // A new due redirect makes this holder eligible while its earlier batch backs off.
    // Rewrite both simultaneously: otherwise prologue's new chapter-1 href would
    // later be mistaken for the old chapter-1 identity.
    expect(await port.move("manuscript://prologue.md", "manuscript://chapter-1.md")).toMatchObject({
      ok: true,
    });
    await app.linkUpdates.sweep();
    expect(await projection(holder)).toBe(
      "[the-gate.md](the-gate.md), [chapter-1.md](chapter-1.md).\n",
    );
    expect(await db.select().from(linkRedirects)).toEqual([]);
  });
});
