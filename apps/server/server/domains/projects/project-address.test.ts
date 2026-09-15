/** Project handles are readable, owner-scoped, and reserved across soft deletion. */
import { describe, expect, it } from "vitest";
import { createInMemoryProjectRepository } from "./adapters/project-repository/in-memory.js";
import { nextProjectSlug } from "./adapters/project-repository/shared.js";

describe("project addresses", () => {
  it("bounds the base and finds the first free numeric suffix in dense reservations", () => {
    const base = "a".repeat(80);
    const reserved = [base, ...Array.from({ length: 1000 }, (_, index) => `${base}-${index + 2}`)];
    expect(nextProjectSlug("a".repeat(200), reserved)).toBe(`${base}-1002`);
    expect(nextProjectSlug("Éowyn", [])).toBe("eowyn");
    expect(nextProjectSlug("!!!", [])).toBe("project");
  });

  it("allocates readable handles without UUID suffixes and preserves them on rename", async () => {
    const repo = createInMemoryProjectRepository();
    const first = await repo.create({ userId: "owner", title: "Silver Moon" });
    expect(first.slug).toBe("silver-moon");
    await repo.update(first.id, { title: "New title" });
    expect((await repo.findById(first.id))?.slug).toBe("silver-moon");
    await repo.softDelete(first.id);
    expect((await repo.create({ userId: "owner", title: "Silver Moon" })).slug).toBe(
      "silver-moon-2",
    );
    expect((await repo.restore(first.id)).slug).toBe("silver-moon");
    expect((await repo.create({ userId: "another", title: "Silver Moon" })).slug).toBe(
      "silver-moon",
    );
  });

  it("rejects duplicate creation IDs without replacing identity or its handle", async () => {
    const repo = createInMemoryProjectRepository();
    const first = await repo.create({ id: "same-id", userId: "owner", title: "Silver Moon" });
    await expect(
      repo.create({ id: first.id, userId: "owner", title: "Silver Moon" }),
    ).rejects.toThrow();
    expect(await repo.findById(first.id)).toEqual(first);
  });

  it("resolves only live handles belonging to the specified owner", async () => {
    const repo = createInMemoryProjectRepository();
    const project = await repo.create({ userId: "owner", title: "Silver Moon" });
    expect(await repo.findLiveByOwnerSlug("owner", project.slug)).toEqual(project);
    expect(await repo.findLiveByOwnerSlug("another", project.slug)).toBeNull();
    expect(await repo.findById(project.slug)).toBeNull();
    await repo.softDelete(project.id);
    expect(await repo.findLiveByOwnerSlug("owner", project.slug)).toBeNull();
  });
});
