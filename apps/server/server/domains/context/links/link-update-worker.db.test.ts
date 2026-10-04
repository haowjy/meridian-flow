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
import { deleteDrizzleRows } from "../../../test-support/drizzle-reset.js";
import { createNoopEventSink } from "../../observability/index.js";
import type { ContextPort } from "../index.js";

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
