import { describe, expect, it } from "vitest";

import { requireUser, resolveUser } from "./auth.js";

describe("Supabase request auth", () => {
  it("returns null when no bearer or auth cookie is present", async () => {
    await expect(resolveUser(new Request("https://server.localhost/api/test"))).resolves.toBeNull();
  });

  it("rejects unauthenticated requests at the route boundary", async () => {
    await expect(
      requireUser(new Request("https://server.localhost/api/test")),
    ).rejects.toMatchObject({
      status: 401,
    });
  });
});
