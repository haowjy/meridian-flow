/**
 * Auth provisioning tests: verify external WorkOS identities map to internal
 * users idempotently and unauthenticated requests are rejected.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createInMemoryUserRepository } from "../domains/projects/index.js";
import { provisionAuthenticatedUser, requireUser, resolveUser } from "./auth.js";

const TEST_WORKOS_COOKIE_PASSWORD = "abcdefghijklmnopqrstuvwxyz123456";

beforeAll(() => {
  process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? "dev-workos-key";
  process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? "dev-workos-client";
  process.env.WORKOS_COOKIE_PASSWORD = TEST_WORKOS_COOKIE_PASSWORD;
});

describe("WorkOS request auth", () => {
  it("returns null when no session cookie is present", async () => {
    await expect(resolveUser(new Request("https://server.localhost/api/test"))).resolves.toBeNull();
  });

  it("rejects unauthenticated requests at the route boundary", async () => {
    await expect(
      requireUser(new Request("https://server.localhost/api/test"), {
        users: createInMemoryUserRepository(),
      }),
    ).rejects.toMatchObject({
      status: 401,
    });
  });
});

describe("auth principal provisioning", () => {
  it("maps external auth to an internal user idempotently", async () => {
    const users = createInMemoryUserRepository();

    const firstUserId = await provisionAuthenticatedUser(
      {
        externalId: "user_01workos",
        email: "user@example.com",
        name: "Test User",
        avatarUrl: null,
      },
      { users },
    );
    const secondUserId = await provisionAuthenticatedUser(
      {
        externalId: "user_01workos",
        email: "new@example.com",
        name: "Renamed User",
        avatarUrl: "https://example.test/avatar.png",
      },
      { users },
    );

    expect(secondUserId).toBe(firstUserId);
  });
});
