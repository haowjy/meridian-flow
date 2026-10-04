/** Production-composed move maintenance, lifecycle recovery, and real write-failure backoff. */
import { randomUUID } from "node:crypto";
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documents,
  linkRedirects,
  projects,
  users,
  works,
} from "@meridian/database/schema";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AppServices,
  composeAppServices,
  createProductionAppPorts,
} from "../../../lib/compose.js";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { deleteDrizzleRows } from "../../../test-support/drizzle-reset.js";
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
      { projectId, name: "Manuscript", slug: "manuscript", scope: "project", isPrimary: true },
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

  async function seed(holderUri = "manuscript://chapter-2.md", extra = "") {
    const target = await port.createTrackedDocument("manuscript://chapter-1.md", "The beginning.");
    expect(target.ok).toBe(true);
    const href = holderUri.startsWith("scratch") ? "manuscript://chapter-1.md" : "chapter-1.md";
    const holder = await port.createTrackedDocument(
      holderUri,
      `[chapter-1.md](${href}) and [enter the story](${href})${extra}.`,
    );
    if (!holder.ok) throw new Error(JSON.stringify(holder.error));
    return holder.value.documentId;
  }
  async function rename() {
    const result = await port.move("manuscript://chapter-1.md", "manuscript://the-gate.md");
    expect(result).toMatchObject({ ok: true, value: { linkUpdate: { links: 2, documents: 1 } } });
    await app.linkUpdates.sweep();
  }
  async function projection(id: string) {
    const [row] = await db.select().from(documents).where(eq(documents.id, id));
    return row?.markdownProjection;
  }
  it("a rename kicks the worker, rewrites hrefs and exact words, consumes redirects, and resolves the ordinary address", async () => {
    const holder = await seed();
    expect(await port.move("manuscript://chapter-1.md", "manuscript://the-gate.md")).toMatchObject({
      ok: true,
      value: { linkUpdate: { links: 2, documents: 1 } },
    });
    await expect
      .poll(() => projection(holder))
      .toBe("[the-gate.md](the-gate.md) and [enter the story](the-gate.md).\n");
    expect(await db.select().from(linkRedirects)).toEqual([]);
    expect(
      await app.documentLinks.resolve({
        projectId,
        userId,
        holder: { documentId: holder, href: "the-gate.md" },
        target: { kind: "relative", path: "the-gate.md", baseUri: "manuscript://chapter-2.md" },
      }),
    ).toMatchObject({ uri: "manuscript://the-gate.md" });
  });
  it("keeps archived Work holders pending and rewrites them on the next pass after unarchive", async () => {
    const holder = await seed("scratch://@draft/chapter-2.md");
    await db.update(works).set({ archivedAt: new Date() }).where(eq(works.id, workId));
    const result = await port.move("manuscript://chapter-1.md", "manuscript://the-gate.md");
    expect(result).toMatchObject({ ok: true, value: { linkUpdate: { links: 0, documents: 0 } } });
    await app.linkUpdates.sweep();
    expect(await db.select().from(linkRedirects)).toHaveLength(1);
    expect(await projection(holder)).toContain("chapter-1.md");
    await db.update(works).set({ archivedAt: null }).where(eq(works.id, workId));
    expect(await app.linkUpdates.sweep()).toBe(1);
    expect(await projection(holder)).toBe(
      "[the-gate.md](manuscript://the-gate.md) and [enter the story](manuscript://the-gate.md).\n",
    );
    expect(await db.select().from(linkRedirects)).toEqual([]);
  });
  it("defers a whole renumber batch until its deleted target is restored", async () => {
    const a = await port.createTrackedDocument("manuscript://ch6.md", "A.");
    expect(a.ok).toBe(true);
    if (!a.ok) throw new Error("Missing A");
    await port.createTrackedDocument("manuscript://ch5.md", "B.");
    const holder = await port.createTrackedDocument(
      "scratch://@draft/holder.md",
      "[A](manuscript://ch6.md) and [B](manuscript://ch5.md).",
    );
    if (!holder.ok) throw new Error("Missing holder");
    const before = await projection(holder.value.documentId);
    await db.update(works).set({ archivedAt: new Date() }).where(eq(works.id, workId));
    expect(await port.move("manuscript://ch6.md", "manuscript://ch7.md")).toMatchObject({
      ok: true,
    });
    await app.linkUpdates.sweep();
    expect(await port.move("manuscript://ch5.md", "manuscript://ch6.md")).toMatchObject({
      ok: true,
    });
    await app.linkUpdates.sweep();
    await db
      .update(documents)
      .set({ deletedAt: new Date() })
      .where(eq(documents.id, a.value.documentId));
    await db.update(works).set({ archivedAt: null }).where(eq(works.id, workId));
    expect(await app.linkUpdates.sweep()).toBe(0);
    expect(await projection(holder.value.documentId)).toBe(before);
    const pending = await db.select().from(linkRedirects);
    expect(pending).toHaveLength(2);
    expect(pending.every((row) => row.attempts === 0 && row.retryAfter === null)).toBe(true);
    await db.update(documents).set({ deletedAt: null }).where(eq(documents.id, a.value.documentId));
    expect(await app.linkUpdates.sweep()).toBe(1);
    expect(await projection(holder.value.documentId)).toBe(
      "[A](manuscript://ch7.md) and [B](manuscript://ch6.md).\n",
    );
    expect(await db.select().from(linkRedirects)).toEqual([]);
  });
  it("leaves another project's personal link dashed instead of naming its same-named occupant", async () => {
    const projectB = randomUUID();
    await db.insert(projects).values({ id: projectB, userId, name: "Other", slug: "other" });
    await db
      .insert(works)
      .values({ projectId: projectB, createdByUserId: userId, name: "No Work", isNoWork: true });
    const other = app.contextPorts.forProject(projectB, userId, new Map());
    const target = await port.createTrackedDocument("user://cast.md", "Personal cast.");
    expect(target.ok).toBe(true);
    const localHolder = await port.createTrackedDocument(
      "manuscript://holder.md",
      "[cast](user://cast.md).",
    );
    if (!localHolder.ok) throw new Error("Missing local holder");
    expect(
      await other.createTrackedDocument("manuscript://cast.md", "Unrelated cast."),
    ).toMatchObject({ ok: true });
    const holder = await other.createTrackedDocument(
      "manuscript://holder.md",
      "[cast](user://cast.md).",
    );
    if (!holder.ok) throw new Error("Missing holder");
    const before = await projection(holder.value.documentId);
    if (!target.ok) throw new Error("Missing personal target");
    const [personalRow] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, target.value.documentId));
    const [localRow] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, localHolder.value.documentId));
    if (!personalRow || !localRow) throw new Error("Missing source rows");
    const tree = new DrizzleContextTreeMutationStore(db);
    const source = await tree.inspect(personalRow.contextSourceId, "cast.md");
    if (source?.kind !== "file") throw new Error("Missing personal source");
    // Exercise the canonical move commit directly: the existing aggregate's
    // destination membership check rejects personal-to-project port moves.
    const moved = await tree.commitMove({
      source,
      destinationSourceId: localRow.contextSourceId,
      destinationPath: "cast.md",
      expectedTarget: { state: "absent" },
      overwrite: false,
      destinationFiletype: "markdown",
      graduateProvisionalName: false,
      mover: { userId },
    });
    if (!moved.ok) throw new Error(JSON.stringify(moved.error));
    expect(moved).toMatchObject({
      ok: true,
      value: { linkUpdate: { links: 1, documents: 1 } },
    });
    await app.linkUpdates.sweep();
    expect(await projection(localHolder.value.documentId)).toBe("[cast](manuscript://cast.md).\n");
    expect(await projection(holder.value.documentId)).toBe(before);
    expect(await db.select().from(linkRedirects)).toEqual([]);
    expect(
      await app.documentLinks.resolve({
        projectId: projectB,
        userId,
        holder: { documentId: holder.value.documentId, href: "user://cast.md" },
        target: { kind: "scheme", uri: "user://cast.md" },
      }),
    ).toBeNull();
  });
  it("serializes an overwrite with a worker holding the victim of a committed redirect", async () => {
    await app.linkUpdates.stop();
    await port.createTrackedDocument("manuscript://a0.md", "A.");
    const holder = await port.createTrackedDocument("manuscript://b.md", "[A](a0.md).");
    if (!holder.ok) throw new Error("Missing B");
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
    const [sourceRow] = await db
      .select()
      .from(contextSources)
      .where(eq(contextSources.projectId, projectId));
    if (!sourceRow) throw new Error("Missing source");
    const source = await tree.inspect(sourceRow.id, "a.md");
    const victim = await tree.inspect(sourceRow.id, "b.md");
    if (source?.kind !== "file" || victim?.kind !== "file") throw new Error("Missing move entries");
    const sweeping = worker.sweep();
    const pid = await holding;
    const moving = tree.commitMove({
      source,
      destinationSourceId: sourceRow.id,
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
    } finally {
      release();
    }
    try {
      expect(await moving).toMatchObject({ ok: true });
      expect(await sweeping).toBe(1);
      // The move captures a fresh a.md redirect after the worker consumed a0.md.
      // Its holder is now deleted, so that new redirect legitimately stays pending.
      expect(await db.select().from(linkRedirects)).toMatchObject([{ href: "a.md", attempts: 0 }]);
      const [deleted] = await db
        .select()
        .from(documents)
        .where(eq(documents.id, holder.value.documentId));
      expect(deleted?.deletedAt).not.toBeNull();
    } finally {
      await worker.stop();
    }
  });
  it("backs off a failing rewrite without losing content or redirects, then succeeds", async () => {
    expect(await port.createTrackedDocument("manuscript://prologue.md", "Prologue.")).toMatchObject(
      { ok: true },
    );
    const holder = await seed("manuscript://chapter-2.md", ", [prologue.md](prologue.md)");
    const before = await projection(holder);
    await db.execute(
      sql.raw(`CREATE FUNCTION p5w_rewrite_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id = '${holder}' THEN RAISE EXCEPTION 'rewrite storage unavailable'; END IF; RETURN NEW; END $$`),
    );
    await db.execute(
      sql`CREATE TRIGGER p5w_rewrite_failure BEFORE UPDATE OF markdown_projection ON documents FOR EACH ROW EXECUTE FUNCTION p5w_rewrite_failure()`,
    );
    await rename();
    const [pending] = await db.select().from(linkRedirects);
    expect(pending?.attempts).toBe(1);
    expect(pending?.retryAfter?.getTime()).toBeGreaterThan(Date.now());
    expect(await projection(holder)).toBe(before);
    expect(await app.linkUpdates.sweep()).toBe(0);
    expect((await db.select().from(linkRedirects))[0]?.attempts).toBe(1);
    await db.execute(sql`DROP TRIGGER p5w_rewrite_failure ON documents`);
    // A new due redirect makes this holder eligible while its earlier batch backs off.
    // Rewrite both simultaneously: otherwise prologue's new chapter-1 href would
    // later be mistaken for the old chapter-1 identity.
    await db.update(linkRedirects).set({ retryAfter: new Date(Date.now() + 60_000) });
    expect(await port.move("manuscript://prologue.md", "manuscript://chapter-1.md")).toMatchObject({
      ok: true,
    });
    await app.linkUpdates.sweep();
    expect(await projection(holder)).toBe(
      "[the-gate.md](the-gate.md) and [enter the story](the-gate.md), [chapter-1.md](chapter-1.md).\n",
    );
    expect(await db.select().from(linkRedirects)).toEqual([]);
  });
});
