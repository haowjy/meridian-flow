import { afterEach, describe, expect, it } from "vitest";
import { resolveAuthRedirectUri } from "./auth-redirect-uri";
import { resetAppServerConfigForTests } from "./config";

const envSnapshot = process.env;

afterEach(() => {
  process.env = { ...envSnapshot };
  resetAppServerConfigForTests();
});

describe("resolveAuthRedirectUri", () => {
  it("uses request origin for portless localhost in development", () => {
    process.env.APP_ENV = "dev";
    process.env.SUPABASE_AUTH_REDIRECT_URI = "https://app.meridian.localhost/api/auth/callback";
    expect(resolveAuthRedirectUri(new Request("https://app.meridian.localhost/sign-in"))).toBe(
      "https://app.meridian.localhost/api/auth/callback",
    );
  });

  it("uses request origin for Tailscale hosts in development", () => {
    process.env.APP_ENV = "dev";
    process.env.SUPABASE_AUTH_REDIRECT_URI = "https://app.meridian.localhost/api/auth/callback";
    expect(resolveAuthRedirectUri(new Request("https://writer.tail852a76.ts.net:8444/"))).toBe(
      "https://writer.tail852a76.ts.net:8444/api/auth/callback",
    );
  });

  it("uses configured redirect in production", () => {
    process.env.APP_ENV = "production";
    process.env.SUPABASE_AUTH_REDIRECT_URI = "https://app.example.com/api/auth/callback";
    expect(resolveAuthRedirectUri(new Request("https://writer.tail852a76.ts.net:8444/"))).toBe(
      "https://app.example.com/api/auth/callback",
    );
  });
});
