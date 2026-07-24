/**
 * Auth provisioning tests: verify external WorkOS identities map to internal
 * users idempotently and unauthenticated requests are rejected.
 */
import { randomUUID } from "node:crypto";
import type { ProjectId } from "@meridian/contracts/runtime";
import { createApp, toWebHandler } from "nitro/h3";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInMemoryUserRepository,
  type ProjectBootstrapRepository,
} from "../domains/projects/index.js";

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

function createTestProjectBootstrap(): {
  projects: ProjectBootstrapRepository;
  bootstrapCalls: number;
  readinessChecks: number;
  personalProjectId: ProjectId | null;
} {
  let personalProjectId: ProjectId | null = null;
  let bootstrapCalls = 0;
  let readinessChecks = 0;
  let ready = false;

  async function ensureDefaultBootstrap() {
    bootstrapCalls += 1;
    personalProjectId = randomUUID() as ProjectId;
    ready = true;
    return {
      projectId: personalProjectId,
      workId: randomUUID() as never,
      threadId: randomUUID() as never,
      documentId: randomUUID() as never,
      contextSourceId: randomUUID() as never,
      agentDefinitionId: randomUUID() as never,
      uri: "manuscript://chapter-1.md" as never,
    };
  }

  return {
    get personalProjectId() {
      return personalProjectId;
    },
    get bootstrapCalls() {
      return bootstrapCalls;
    },
    get readinessChecks() {
      return readinessChecks;
    },
    projects: {
      async findPersonalProjectId() {
        return personalProjectId;
      },
      async ensureDefaultBootstrapReady() {
        readinessChecks += 1;
        if (!ready) await ensureDefaultBootstrap();
        return true;
      },
      ensureDefaultBootstrap,
    },
  };
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
    const bootstrap = createTestProjectBootstrap();
    await expect(
      requireUser(requestWithCookie(null), {
        users: createInMemoryUserRepository(),
        projects: bootstrap.projects,
      }),
    ).rejects.toMatchObject({
      status: 401,
    });
  });

  it("rejects forged session cookies at the route boundary", async () => {
    const bootstrap = createTestProjectBootstrap();
    await expect(
      requireUser(requestWithCookie("wos-session=tampered"), {
        users: createInMemoryUserRepository(),
        projects: bootstrap.projects,
      }),
    ).rejects.toMatchObject({
      status: 401,
    });
  });

  it("provisions an internal user id from a sealed session cookie", async () => {
    mockWithAuthFromSealedCookie();

    const users = createInMemoryUserRepository();
    const bootstrap = createTestProjectBootstrap();
    const cookie = await mintTestSessionCookie({ email: "provisioned@example.com" });

    const resolved = await requireUser(requestWithCookie(cookie), {
      users,
      projects: bootstrap.projects,
    });

    expect(resolved.externalId).toBe(TEST_EXTERNAL_USER_ID);
    expect(resolved.email).toBe("provisioned@example.com");
    expect(resolved.userId).toBeTruthy();
    expect(bootstrap.bootstrapCalls).toBe(1);
    expect(bootstrap.personalProjectId).toBeTruthy();

    const second = await requireUser(requestWithCookie(cookie), {
      users,
      projects: bootstrap.projects,
    });
    expect(second.userId).toBe(resolved.userId);
    expect(bootstrap.readinessChecks).toBe(2);
    expect(bootstrap.bootstrapCalls).toBe(1);
  });
});

describe("auth principal provisioning", () => {
  let provisionAuthenticatedUser: typeof import("./auth.js").provisionAuthenticatedUser;
  let AccountLinkConflictError: typeof import("../domains/projects/index.js").AccountLinkConflictError;

  beforeAll(async () => {
    process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? "dev-workos-key";
    process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? "client_auth_test";
    process.env.WORKOS_COOKIE_PASSWORD = TEST_WORKOS_COOKIE_PASSWORD;
    process.env.WORKOS_REDIRECT_URI =
      process.env.WORKOS_REDIRECT_URI ?? "https://app.meridian.localhost/api/auth/callback";
    provisionAuthenticatedUser = (await import("./auth.js")).provisionAuthenticatedUser;
    AccountLinkConflictError = (await import("../domains/projects/index.js"))
      .AccountLinkConflictError;
  });

  it("maps external auth to an internal user idempotently", async () => {
    const users = createInMemoryUserRepository();
    const bootstrap = createTestProjectBootstrap();

    const firstUserId = await provisionAuthenticatedUser(
      {
        externalId: "user_01workos",
        email: "user@example.com",
        name: "Test User",
        avatarUrl: null,
      },
      { users, projects: bootstrap.projects },
    );
    const secondUserId = await provisionAuthenticatedUser(
      {
        externalId: "user_01workos",
        email: "new@example.com",
        name: "Renamed User",
        avatarUrl: "https://example.test/avatar.png",
      },
      { users, projects: bootstrap.projects },
    );

    expect(secondUserId).toBe(firstUserId);
    expect(bootstrap.readinessChecks).toBe(2);
    expect(bootstrap.bootstrapCalls).toBe(1);
  });

  it("surfaces account-link conflicts as a structured 409 without bootstrapping", async () => {
    const bootstrap = createTestProjectBootstrap();
    const users = createInMemoryUserRepository();
    users.ensureUser = async () => {
      throw new AccountLinkConflictError();
    };

    await expect(
      provisionAuthenticatedUser(
        {
          externalId: "user_conflict",
          email: "conflict@example.com",
          name: "Conflict User",
          avatarUrl: null,
        },
        { users, projects: bootstrap.projects },
      ),
    ).rejects.toMatchObject({
      status: 409,
      data: { code: "account_link_conflict" },
      message:
        "This email is already associated with a different sign-in identity. Sign in with the original account or contact support.",
    });
    expect(bootstrap.bootstrapCalls).toBe(0);
  });

  it("serializes account-link conflicts without provider or internal identities", async () => {
    const bootstrap = createTestProjectBootstrap();
    const users = createInMemoryUserRepository();
    users.ensureUser = async () => {
      throw new AccountLinkConflictError();
    };
    const app = createApp();
    app.use(async () => {
      await provisionAuthenticatedUser(
        {
          externalId: "user_conflict",
          email: "conflict@example.com",
          name: "Conflict User",
          avatarUrl: null,
        },
        { users, projects: bootstrap.projects },
      );
    });

    const response = await toWebHandler(app)(new Request("https://server.localhost/api/test"));
    const body = await response.text();
    expect(response.status).toBe(409);
    expect(JSON.parse(body)).toEqual({
      status: 409,
      message:
        "This email is already associated with a different sign-in identity. Sign in with the original account or contact support.",
      data: { code: "account_link_conflict" },
    });
    expect(body).not.toContain("user_conflict");
    expect(body).not.toContain("conflict@example.com");
    expect(bootstrap.bootstrapCalls).toBe(0);
  });

  it("preserves unrelated provisioning failures", async () => {
    const bootstrap = createTestProjectBootstrap();
    const users = createInMemoryUserRepository();
    const failure = new Error("database unavailable");
    users.ensureUser = async () => {
      throw failure;
    };

    await expect(
      provisionAuthenticatedUser(
        {
          externalId: "user_failure",
          email: "failure@example.com",
          name: "Failure User",
          avatarUrl: null,
        },
        { users, projects: bootstrap.projects },
      ),
    ).rejects.toBe(failure);
    expect(bootstrap.bootstrapCalls).toBe(0);
  });

  it("skips deep bootstrap after durable readiness completes", async () => {
    const users = createInMemoryUserRepository();
    const bootstrap = createTestProjectBootstrap();
    const externalUser = {
      externalId: "user_bootstrap_once",
      email: "bootstrap@example.com",
      name: "Bootstrap User",
      avatarUrl: null,
    };

    await provisionAuthenticatedUser(externalUser, { users, projects: bootstrap.projects });
    expect(bootstrap.bootstrapCalls).toBe(1);

    await provisionAuthenticatedUser(externalUser, { users, projects: bootstrap.projects });
    expect(bootstrap.readinessChecks).toBe(2);
    expect(bootstrap.bootstrapCalls).toBe(1);
  });

  it("does not fail authentication while bootstrap seed repair remains pending", async () => {
    const users = createInMemoryUserRepository();
    const externalUser = {
      externalId: "user_bootstrap_seed_failure",
      email: "bootstrap-seed-failure@example.com",
      name: "Bootstrap User",
      avatarUrl: null,
    };
    const projects: ProjectBootstrapRepository = {
      async findPersonalProjectId() {
        return null;
      },
      async ensureDefaultBootstrapReady() {
        return false;
      },
      async ensureDefaultBootstrap() {
        throw new Error("deep bootstrap should remain behind the readiness port");
      },
    };

    await expect(
      provisionAuthenticatedUser(externalUser, { users, projects }),
    ).resolves.toBeTruthy();
  });
});
