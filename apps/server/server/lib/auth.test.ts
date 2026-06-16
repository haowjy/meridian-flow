/**
 * Auth provisioning tests: verify external WorkOS identities map to internal
 * users idempotently and unauthenticated requests are rejected.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryUserRepository } from "../domains/projects/index.js";

const TEST_WORKOS_COOKIE_PASSWORD = "abcdefghijklmnopqrstuvwxyz123456";
const TEST_SESSION_ID = "session_test_01";
const TEST_EXTERNAL_USER_ID = "user_01workos";

const { buildFakeAccessToken } = vi.hoisted(() => {
  const sessionId = "session_test_01";
  const externalUserId = "user_01workos";

  function buildFakeAccessToken(): string {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        sid: sessionId,
        sub: externalUserId,
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString("base64url");
    return `${header}.${payload}.fakesignature`;
  }

  return { buildFakeAccessToken };
});

function readSealedSessionCookie(cookieHeader: string): string {
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName !== "wos-session") continue;
    return decodeURIComponent(rawValue.join("="));
  }
  throw new Error("missing wos-session cookie");
}

async function mintTestSessionCookie(
  options: {
    userId?: string;
    email?: string;
    firstName?: string | null;
    lastName?: string | null;
    password?: string;
  } = {},
): Promise<string> {
  const { sessionEncryption } = await import("@workos/authkit-session");
  const user = {
    object: "user",
    id: options.userId ?? TEST_EXTERNAL_USER_ID,
    email: options.email ?? "user@example.com",
    emailVerified: true,
    firstName: options.firstName ?? "Test",
    lastName: options.lastName ?? "User",
    profilePictureUrl: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };

  const sealed = await sessionEncryption.sealData(
    {
      user,
      accessToken: buildFakeAccessToken(),
      refreshToken: "refresh_test_token",
    },
    { password: options.password ?? TEST_WORKOS_COOKIE_PASSWORD, ttl: 0 },
  );

  return `wos-session=${encodeURIComponent(sealed)}`;
}

function requestWithCookie(cookie: string | null): Request {
  return new Request("https://server.localhost/api/test", {
    headers: cookie ? { cookie } : undefined,
  });
}

describe("WorkOS request auth", () => {
  let resolveUser: typeof import("./auth.js").resolveUser;
  let requireUser: typeof import("./auth.js").requireUser;
  let authkitService: typeof import("./auth.js").authkitService;

  beforeAll(async () => {
    process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? "dev-workos-key";
    process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? "client_auth_test";
    process.env.WORKOS_COOKIE_PASSWORD = TEST_WORKOS_COOKIE_PASSWORD;
    process.env.WORKOS_REDIRECT_URI =
      process.env.WORKOS_REDIRECT_URI ?? "https://app.meridian.localhost/api/auth/callback";

    vi.resetModules();
    const auth = await import("./auth.js");
    resolveUser = auth.resolveUser;
    requireUser = auth.requireUser;
    authkitService = auth.authkitService;
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function mockWithAuthFromSealedCookie(): void {
    vi.spyOn(authkitService, "withAuth").mockImplementation(async (request) => {
      const cookieHeader = request.headers.get("cookie");
      if (!cookieHeader) return { auth: { user: null } };

      const { sessionEncryption } = await import("@workos/authkit-session");
      const session = await sessionEncryption.unsealData<{
        user: {
          id: string;
          email: string;
          firstName: string | null;
          lastName: string | null;
          profilePictureUrl: string | null;
        };
        accessToken: string;
        refreshToken: string;
      }>(readSealedSessionCookie(cookieHeader), {
        password: TEST_WORKOS_COOKIE_PASSWORD,
        ttl: 0,
      });

      return {
        auth: {
          user: session.user,
          sessionId: TEST_SESSION_ID,
          accessToken: session.accessToken,
          refreshToken: session.refreshToken,
          claims: { sid: TEST_SESSION_ID },
        },
      } as Awaited<ReturnType<typeof authkitService.withAuth>>;
    });
  }

  it("returns null when no session cookie is present", async () => {
    await expect(resolveUser(requestWithCookie(null))).resolves.toBeNull();
  });

  it("returns null for a malformed sealed cookie", async () => {
    await expect(
      resolveUser(requestWithCookie("wos-session=not-a-valid-sealed-session")),
    ).resolves.toBeNull();
  });

  it("returns null for a cookie sealed with the wrong password", async () => {
    const cookie = await mintTestSessionCookie({
      password: "wrong-password-that-is-long-enough!!",
    });
    await expect(resolveUser(requestWithCookie(cookie))).resolves.toBeNull();
  });

  it("resolves a user from a real sealed wos-session cookie", async () => {
    mockWithAuthFromSealedCookie();

    const cookie = await mintTestSessionCookie({
      email: "session-user@example.com",
      firstName: "Session",
      lastName: "User",
    });

    await expect(resolveUser(requestWithCookie(cookie))).resolves.toEqual({
      externalId: TEST_EXTERNAL_USER_ID,
      email: "session-user@example.com",
      name: "Session User",
      avatarUrl: null,
    });
    expect(authkitService.withAuth).toHaveBeenCalledOnce();
  });

  it("rejects unauthenticated requests at the route boundary", async () => {
    await expect(
      requireUser(requestWithCookie(null), {
        users: createInMemoryUserRepository(),
      }),
    ).rejects.toMatchObject({
      status: 401,
    });
  });

  it("rejects forged session cookies at the route boundary", async () => {
    await expect(
      requireUser(requestWithCookie("wos-session=tampered"), {
        users: createInMemoryUserRepository(),
      }),
    ).rejects.toMatchObject({
      status: 401,
    });
  });

  it("provisions an internal user id from a sealed session cookie", async () => {
    mockWithAuthFromSealedCookie();

    const users = createInMemoryUserRepository();
    const cookie = await mintTestSessionCookie({ email: "provisioned@example.com" });

    const resolved = await requireUser(requestWithCookie(cookie), { users });

    expect(resolved.externalId).toBe(TEST_EXTERNAL_USER_ID);
    expect(resolved.email).toBe("provisioned@example.com");
    expect(resolved.userId).toBeTruthy();

    const second = await requireUser(requestWithCookie(cookie), { users });
    expect(second.userId).toBe(resolved.userId);
  });
});

describe("auth principal provisioning", () => {
  let provisionAuthenticatedUser: typeof import("./auth.js").provisionAuthenticatedUser;

  beforeAll(async () => {
    process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? "dev-workos-key";
    process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? "client_auth_test";
    process.env.WORKOS_COOKIE_PASSWORD = TEST_WORKOS_COOKIE_PASSWORD;
    process.env.WORKOS_REDIRECT_URI =
      process.env.WORKOS_REDIRECT_URI ?? "https://app.meridian.localhost/api/auth/callback";
    provisionAuthenticatedUser = (await import("./auth.js")).provisionAuthenticatedUser;
  });

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
