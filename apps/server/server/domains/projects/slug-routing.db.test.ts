/**
 * Postgres regression for #290: a non-UUID id (e.g. a project slug landing in a
 * `:projectId` route) must resolve to not-found at the repository boundary,
 * never a Postgres uuid-parse 500 leaking out of `findById`.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("slug routing (postgres)", () => {});
} else {
  describe("slug routing (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { createDrizzleProjectRepository } = await import(
      "./adapters/project-repository/drizzle.js"
    );
    const { createDrizzleWorkRepository } = await import("./adapters/work-repository/drizzle.js");
    const { createWorkProjectionMutation } = await import("./adapters/work-projection-mutation.js");
    const { createDrizzleContextCatalog } = await import("../context/adapters/context-catalog.js");
    const { createDrizzleProjectContextAvailability } = await import(
      "../context/adapters/project-context-availability.js"
    );
    const { WorkNameConflictError } = await import("./ports/work-repository.js");
    const { truncateDrizzleTables } = await import("../../test-support/drizzle-reset.js");

    const db = createDb(DATABASE_URL, { max: 4 });
    const availability = createDrizzleProjectContextAvailability(db);
    const projectionMutation = createWorkProjectionMutation({
      db,
      availability,
      catalog: createDrizzleContextCatalog(db, undefined, {
        availabilityMutations: availability,
      }),
    });
    const workRepository = () =>
      createDrizzleWorkRepository({
        db,
        hasUnreviewedDraft: async () => false,
        projectionMutation,
      });

    beforeEach(async () => {
      await truncateDrizzleTables(db, [schema.users, schema.projects, schema.works]);
    });
    afterAll(async () => db.$client.end());

    it("project findById on a non-UUID slug resolves to null", async () => {
      const repo = createDrizzleProjectRepository({ db });
      await expect(repo.findById("probe-rowmenu-not-a-uuid" as never)).resolves.toBeNull();
    });

    it("allocates concurrent owner-scoped handles and reserves deleted addresses", async () => {
      const userId = "93b1f764-1234-f678-0712-123456789ad0";
      const anotherUserId = "93b1f764-1234-f678-0712-123456789ad1";
      await db.insert(schema.users).values([
        { id: userId, externalId: "readable-owner", email: "readable-owner@example.com" },
        {
          id: anotherUserId,
          externalId: "readable-another",
          email: "readable-another@example.com",
        },
      ]);
      const repo = createDrizzleProjectRepository({ db });
      const created = await Promise.all(
        Array.from({ length: 4 }, () => repo.create({ userId, title: "Silver Moon" })),
      );
      expect(created.map((project) => project.slug).sort()).toEqual([
        "silver-moon",
        "silver-moon-2",
        "silver-moon-3",
        "silver-moon-4",
      ]);
      const first = created.find((project) => project.slug === "silver-moon");
      if (!first) throw new Error("Missing base project handle");
      await expect(repo.create({ id: first.id, userId, title: first.title })).rejects.toThrow();
      expect(await repo.findById(first.id)).toEqual(first);
      expect(await repo.findLiveByOwnerSlug(userId, first.slug)).toEqual(first);
      expect(await repo.findLiveByOwnerSlug(anotherUserId, first.slug)).toBeNull();
      await repo.update(first.id, { title: "Changed title" });
      await repo.softDelete(first.id);
      expect(await repo.findLiveByOwnerSlug(userId, first.slug)).toBeNull();
      expect((await repo.create({ userId, title: "Silver Moon" })).slug).toBe("silver-moon-5");
      expect((await repo.restore(first.id)).slug).toBe("silver-moon");
      expect((await repo.create({ userId: anotherUserId, title: "Silver Moon" })).slug).toBe(
        "silver-moon",
      );
    });

    it("reserves chat handles through trash and resolves only live same-project chats", async () => {
      const { createDrizzleThreadRepository } = await import(
        "../threads/adapters/drizzle/thread-repository.js"
      );
      const userId = "93b1f764-1234-f678-0712-123456789ae0";
      await db
        .insert(schema.users)
        .values({ id: userId, externalId: "chat-handles", email: "chat-handles@example.com" });
      const repo = createDrizzleProjectRepository({ db });
      const project = await repo.create({ userId, title: "Chat handles" });
      const another = await repo.create({ userId, title: "Another" });
      const chats = createDrizzleThreadRepository(db);
      const created = await Promise.all(
        Array.from({ length: 3 }, () => chats.create({ projectId: project.id, userId })),
      );
      expect(created.map((chat) => chat.slug).sort()).toEqual(["chat", "chat-2", "chat-3"]);
      const first = created[0];
      if (!first?.slug) throw new Error("Missing chat handle");
      expect(await chats.findLiveByProjectSlug(project.id, first.slug)).toMatchObject({
        id: first.id,
      });
      expect(await chats.findLiveByProjectSlug(another.id, first.slug)).toBeNull();
      await chats.setTrashState(first.id, "deleted");
      expect(await chats.findLiveByProjectSlug(project.id, first.slug)).toBeNull();
      expect((await chats.create({ projectId: project.id, userId })).slug).toBe("chat-4");
      await chats.setTrashState(first.id, "visible");
      expect(await chats.findLiveByProjectSlug(project.id, first.slug)).toMatchObject({
        id: first.id,
        slug: first.slug,
      });
      await repo.softDelete(project.id);
      expect(await chats.findLiveByProjectSlug(project.id, first.slug)).toBeNull();
    });

    it("work findById on a non-UUID slug resolves to null", async () => {
      const repo = workRepository();
      await expect(repo.findById("also-a-slug" as never)).resolves.toBeNull();
    });

    it("create and find accept canonical UUIDs regardless of version or variant bits", async () => {
      const userId = "93b1f764-1234-f678-0712-123456789ab0";
      const projectId = "93b1f764-1234-f678-0712-123456789ab1";
      const workId = "93b1f764-1234-9678-f712-123456789ab2";
      await db.insert(schema.users).values({
        id: userId,
        externalId: "slug-routing-uuid-grammar",
        email: "uuid-grammar@example.com",
      });

      const projects = createDrizzleProjectRepository({ db });
      const works = workRepository();
      await projects.create({ id: projectId, userId, title: "UUID grammar" });
      await works.create({ id: workId, projectId, createdByUserId: userId, name: "Work" });

      await expect(projects.findById(projectId.toUpperCase() as never)).resolves.toMatchObject({
        id: projectId,
      });
      await expect(works.findById(workId as never)).resolves.toMatchObject({ id: workId });
    });

    it("maps case-insensitive active Work name conflicts to the domain error", async () => {
      const userId = "93b1f764-1234-f678-0712-123456789ac0";
      const projectId = "93b1f764-1234-f678-0712-123456789ac1";
      await db.insert(schema.users).values({
        id: userId,
        externalId: "work-name-conflict",
        email: "work-name-conflict@example.com",
      });

      const projects = createDrizzleProjectRepository({ db });
      const works = workRepository();
      await projects.create({ id: projectId, userId, title: "Name conflict" });
      await works.create({ projectId, createdByUserId: userId, name: "Book Two" });

      await expect(
        works.create({ projectId, createdByUserId: userId, name: "book two" }),
      ).rejects.toBeInstanceOf(WorkNameConflictError);
    });
  });
}
