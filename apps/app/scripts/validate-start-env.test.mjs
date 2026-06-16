import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { validateStartEnv } from "./validate-start-env.mjs";

const scriptPath = fileURLToPath(new URL("./validate-start-env.mjs", import.meta.url));

const baseProductionEnv = {
  NODE_ENV: "production",
  APP_ENV: "production",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.example.signature",
  MERIDIAN_API_ORIGIN: "https://server.meridian.example",
  WORKOS_API_KEY: "workos_live_abcdefghijklmnopqrstuvwxyz",
  WORKOS_CLIENT_ID: "client_abcdefghijklmnopqrstuvwxyz",
  WORKOS_COOKIE_PASSWORD: "abcdefghijklmnopqrstuvwxyz123456",
  WORKOS_REDIRECT_URI: "https://app.meridian.example/api/auth/callback",
};

describe("validateStartEnv", () => {
  it("passes for production values", () => {
    const result = validateStartEnv(baseProductionEnv);

    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("rejects missing and development placeholder Supabase values", () => {
    const result = validateStartEnv({
      ...baseProductionEnv,
      SUPABASE_URL: "http://127.0.0.1:54421",
      SUPABASE_ANON_KEY: "dev-anon-key",
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "SUPABASE_URL" }),
        expect.objectContaining({ name: "SUPABASE_ANON_KEY" }),
      ]),
    );
  });

  it("rejects placeholder WorkOS API and client values", () => {
    const result = validateStartEnv({
      ...baseProductionEnv,
      WORKOS_API_KEY: "sk_test_placeholder",
      WORKOS_CLIENT_ID: "client_...",
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "WORKOS_API_KEY" }),
        expect.objectContaining({ name: "WORKOS_CLIENT_ID" }),
      ]),
    );
  });

  it("accepts WorkOS staging API keys in production-built staging", () => {
    const result = validateStartEnv({
      ...baseProductionEnv,
      APP_ENV: "staging",
      WORKOS_API_KEY: "sk_test_workos_staging",
      WORKOS_CLIENT_ID: "client_staging_value",
    });

    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("rejects weak cookie secrets and malformed redirect URIs in production", () => {
    const result = validateStartEnv({
      ...baseProductionEnv,
      WORKOS_COOKIE_PASSWORD: "too-short",
      WORKOS_REDIRECT_URI: "notaurl",
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "WORKOS_COOKIE_PASSWORD" }),
        expect.objectContaining({ name: "WORKOS_REDIRECT_URI" }),
      ]),
    );
  });

  it("requires the WorkOS redirect URI to use the app-owned auth callback path", () => {
    const result = validateStartEnv({
      ...baseProductionEnv,
      WORKOS_REDIRECT_URI: "https://app.meridian.example/api/threads",
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        name: "WORKOS_REDIRECT_URI",
        issue: expect.stringContaining("/api/auth/callback"),
      }),
    );
  });

  it("rejects malformed origins in production", () => {
    const result = validateStartEnv({
      ...baseProductionEnv,
      MERIDIAN_API_ORIGIN: "notaurl",
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ name: "MERIDIAN_API_ORIGIN" }));
  });

  it("exits successfully without production validation outside production", () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: "development" },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Skipping production start env validation");
  });

  it("exits nonzero and prints grouped issues for invalid production env", () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "production",
        APP_ENV: "production",
        SUPABASE_URL: "http://127.0.0.1:54421",
        SUPABASE_ANON_KEY: "dev-anon-key",
        MERIDIAN_API_ORIGIN: "not-a-url",
        WORKOS_API_KEY: "sk_test_placeholder",
        WORKOS_CLIENT_ID: "client_...",
        WORKOS_COOKIE_PASSWORD: "short",
        WORKOS_REDIRECT_URI: "https://app.meridian.example/api/threads",
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Production start blocked");
    expect(result.stderr).toContain("SUPABASE_URL");
    expect(result.stderr).toContain("MERIDIAN_API_ORIGIN");
    expect(result.stderr).toContain("WORKOS_API_KEY");
    expect(result.stderr).toContain("WORKOS_REDIRECT_URI");
  });
});
