import { describe, expect, it } from "vitest";
import { parseAppServerConfig } from "./config";

describe("parseAppServerConfig", () => {
  it("defaults production/dev-login/API config to null-ish values", () => {
    expect(parseAppServerConfig({})).toMatchObject({
      isProduction: false,
      supabaseUrl: null,
      supabaseAnonKey: null,
      devLogin: null,
      devAutologin: false,
      apiOrigin: null,
    });
  });

  it("sets isProduction from NODE_ENV", () => {
    expect(parseAppServerConfig({ NODE_ENV: "production" }).isProduction).toBe(true);
    expect(parseAppServerConfig({ NODE_ENV: "development" }).isProduction).toBe(false);
  });

  it("parses Supabase env and API origin with trimming", () => {
    const config = parseAppServerConfig({
      SUPABASE_URL: "  https://supabase.example.test  ",
      SUPABASE_ANON_KEY: "  anon  ",
      SUPABASE_AUTH_REDIRECT_URI: "  https://app.meridian.localhost/api/auth/callback  ",
      MERIDIAN_API_ORIGIN: "  https://api.meridian.localhost  ",
    });
    expect(config.supabaseUrl).toBe("https://supabase.example.test");
    expect(config.supabaseAnonKey).toBe("anon");
    expect(config.supabaseAuthRedirectUri).toBe("https://app.meridian.localhost/api/auth/callback");
    expect(config.apiOrigin).toBe("https://api.meridian.localhost");
  });

  it("parses dev-login credentials and autologin gate", () => {
    expect(
      parseAppServerConfig({
        NODE_ENV: "development",
        TEST_USER_EMAIL: "  dev@example.test  ",
        TEST_USER_PASSWORD: "  secret  ",
        SUPABASE_DEV_AUTOLOGIN: "1",
      }),
    ).toMatchObject({
      devLogin: { email: "dev@example.test", password: "secret" },
      devAutologin: true,
    });

    expect(
      parseAppServerConfig({
        NODE_ENV: "production",
        TEST_USER_EMAIL: "dev@example.test",
        TEST_USER_PASSWORD: "secret",
        SUPABASE_DEV_AUTOLOGIN: "1",
      }).devAutologin,
    ).toBe(false);
  });
});
