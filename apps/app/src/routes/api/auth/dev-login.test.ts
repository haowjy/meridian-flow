import { getAuthkit } from "@workos/authkit-tanstack-react-start";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleDevLogin } from "@/routes/api/auth/dev-login";
import { getAppServerConfig, resetAppServerConfigForTests } from "@/server/config";
import { isDevAutologinEnabled } from "@/server/dev-auth";

const TEST_PASSWORD = "abcdefghijklmnopqrstuvwxyz123456";

vi.mock("@/server/dev-auth", () => ({
  isDevAutologinEnabled: vi.fn(),
}));

vi.mock("@/server/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/config")>();
  return {
    ...actual,
    getAppServerConfig: vi.fn(),
  };
});

vi.mock("@workos/authkit-tanstack-react-start", () => ({
  getAuthkit: vi.fn(),
}));

vi.mock("@workos/authkit-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workos/authkit-session")>();
  return {
    ...actual,
    validateConfig: vi.fn().mockResolvedValue(undefined),
    getConfig: vi.fn((key: string) => {
      if (key === "clientId") return "client_dev_login_test";
      if (key === "cookiePassword") return TEST_PASSWORD;
      throw new Error(`unexpected config key ${key}`);
    }),
  };
});

function mockEnabledDevLoginConfig(
  workosDevLogin: { email: string; password: string } | null,
): void {
  vi.mocked(getAppServerConfig).mockReturnValue({
    runtime: {} as never,
    isProduction: false,
    devAutologin: workosDevLogin !== null,
    workosClientId: "client_test",
    workosRedirectUri: null,
    workosDevLogin,
    apiOrigin: null,
  });
}

describe("handleDevLogin gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAppServerConfigForTests();
  });

  it("returns 404 when dev autologin is disabled (production gate)", async () => {
    vi.mocked(isDevAutologinEnabled).mockReturnValue(false);

    const response = await handleDevLogin();

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
    expect(getAuthkit).not.toHaveBeenCalled();
  });

  it("returns 404 when dev credentials are missing despite autologin flag", async () => {
    vi.mocked(isDevAutologinEnabled).mockReturnValue(true);
    mockEnabledDevLoginConfig(null);

    const response = await handleDevLogin();

    expect(response.status).toBe(404);
    expect(getAuthkit).not.toHaveBeenCalled();
  });

  it("returns 302 with Set-Cookie when dev autologin is allowed", async () => {
    vi.mocked(isDevAutologinEnabled).mockReturnValue(true);
    mockEnabledDevLoginConfig({ email: "dev@example.test", password: "secret" });

    const saveSession = vi.fn().mockResolvedValue({
      headers: { "Set-Cookie": "wos-session=sealed-session-value; Path=/; HttpOnly" },
    });
    vi.mocked(getAuthkit).mockResolvedValue({
      getWorkOS: () => ({
        userManagement: {
          authenticateWithPassword: vi.fn().mockResolvedValue({
            user: {
              object: "user",
              id: "user_dev_login",
              email: "dev@example.test",
            },
            accessToken: "access-token",
            refreshToken: "refresh-token",
            impersonator: undefined,
          }),
        },
      }),
      saveSession,
    } as never);

    const response = await handleDevLogin();

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/");
    expect(response.headers.get("Set-Cookie")).toContain("wos-session=sealed-session-value");
  });
});
