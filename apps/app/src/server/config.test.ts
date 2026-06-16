import { describe, expect, it } from "vitest";
import { parseAppServerConfig } from "./config";

describe("parseAppServerConfig", () => {
  it("defaults isProduction to false and devAutologin to false", () => {
    expect(parseAppServerConfig({})).toMatchObject({
      isProduction: false,
      workosClientId: null,
      workosDevLogin: null,
      devAutologin: false,
      apiOrigin: null,
    });
  });

  it("sets isProduction from NODE_ENV", () => {
    expect(parseAppServerConfig({ NODE_ENV: "production" }).isProduction).toBe(true);
    expect(parseAppServerConfig({ NODE_ENV: "development" }).isProduction).toBe(false);
  });

  it("parses WorkOS env and API origin with trimming", () => {
    const config = parseAppServerConfig({
      MERIDIAN_API_ORIGIN: "  https://api.meridian.localhost  ",
      WORKOS_CLIENT_ID: "  client_abc  ",
      WORKOS_REDIRECT_URI: "  https://app.meridian.localhost/api/auth/callback  ",
    });
    expect(config.apiOrigin).toBe("https://api.meridian.localhost");
    expect(config.workosClientId).toBe("client_abc");
    expect(config.workosRedirectUri).toBe("https://app.meridian.localhost/api/auth/callback");
  });

  describe("workosDevLogin", () => {
    it("is null when either credential is missing", () => {
      expect(
        parseAppServerConfig({ WORKOS_DEV_LOGIN_EMAIL: "dev@example.test" }).workosDevLogin,
      ).toBe(null);
      expect(parseAppServerConfig({ WORKOS_DEV_LOGIN_PASSWORD: "secret" }).workosDevLogin).toBe(
        null,
      );
    });

    it("requires both trimmed credentials", () => {
      expect(
        parseAppServerConfig({
          WORKOS_DEV_LOGIN_EMAIL: "  dev@example.test  ",
          WORKOS_DEV_LOGIN_PASSWORD: "  secret  ",
        }).workosDevLogin,
      ).toEqual({ email: "dev@example.test", password: "secret" });
    });
  });

  describe("devAutologin", () => {
    const devCreds = {
      WORKOS_DEV_LOGIN_EMAIL: "dev@example.test",
      WORKOS_DEV_LOGIN_PASSWORD: "secret",
      WORKOS_DEV_AUTOLOGIN: "1",
    };

    it("is true when all conditions hold in non-production", () => {
      expect(parseAppServerConfig({ NODE_ENV: "development", ...devCreds }).devAutologin).toBe(
        true,
      );
    });

    it("is false in production even with creds and autologin flag", () => {
      expect(parseAppServerConfig({ NODE_ENV: "production", ...devCreds }).devAutologin).toBe(
        false,
      );
    });

    it("is false without WORKOS_DEV_AUTOLOGIN", () => {
      expect(
        parseAppServerConfig({
          NODE_ENV: "development",
          WORKOS_DEV_LOGIN_EMAIL: devCreds.WORKOS_DEV_LOGIN_EMAIL,
          WORKOS_DEV_LOGIN_PASSWORD: devCreds.WORKOS_DEV_LOGIN_PASSWORD,
        }).devAutologin,
      ).toBe(false);
    });

    it("is false when WORKOS_DEV_AUTOLOGIN is not '1'", () => {
      const base = {
        NODE_ENV: "development",
        WORKOS_DEV_LOGIN_EMAIL: devCreds.WORKOS_DEV_LOGIN_EMAIL,
        WORKOS_DEV_LOGIN_PASSWORD: devCreds.WORKOS_DEV_LOGIN_PASSWORD,
      };
      expect(parseAppServerConfig({ ...base, WORKOS_DEV_AUTOLOGIN: "0" }).devAutologin).toBe(false);
    });
  });
});
