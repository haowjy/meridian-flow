import { describe, expect, it } from "vitest";

import { type ApiStartupEnv, evaluateApiStartupGuards } from "./startup-guards";

const TEST_BASE_ENV: ApiStartupEnv = {
  NODE_ENV: "development",
  APP_ENV: "dev",
  DATABASE_URL: "postgresql://meridian:meridian@localhost:54422/postgres",
  OBJECT_STORE_PROVIDER: "local",
  S3_ACCESS_KEY: undefined,
  S3_SECRET_KEY: undefined,
  WORKOS_API_KEY: "dev-workos-key",
  WORKOS_CLIENT_ID: "dev-workos-client",
  WORKOS_COOKIE_PASSWORD: "local-cookie-password-at-least-32-characters-long",
  API_REPLICA_COUNT: 1,
  DURABLE_EVENT_BACKEND: "none",
};

function withOverrides(overrides: Partial<ApiStartupEnv>): ApiStartupEnv {
  return { ...TEST_BASE_ENV, ...overrides };
}

describe("evaluateApiStartupGuards", () => {
  it("requires a database URL", () => {
    const result = evaluateApiStartupGuards(withOverrides({ DATABASE_URL: undefined }));
    expect(result.errors).toContainEqual(expect.stringContaining("DATABASE_URL"));
  });

  it("fails in production when explicit multi-replica mode has no durable backend", () => {
    const result = evaluateApiStartupGuards(
      withOverrides({ NODE_ENV: "production", API_REPLICA_COUNT: 2 }),
    );
    expect(result.errors).toContainEqual(
      expect.stringContaining("API_REPLICA_COUNT > 1 requires durable event/log coordination"),
    );
  });

  it("warns outside production for multi-replica experiments", () => {
    const result = evaluateApiStartupGuards(
      withOverrides({ NODE_ENV: "development", API_REPLICA_COUNT: 2 }),
    );
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toContainEqual(
      expect.stringContaining("API_REPLICA_COUNT > 1 requires durable event/log coordination"),
    );
  });

  it("rejects production WorkOS placeholder credentials", () => {
    const result = evaluateApiStartupGuards(
      withOverrides({
        NODE_ENV: "production",
        APP_ENV: "production",
        WORKOS_API_KEY: "sk_test_placeholder",
        WORKOS_CLIENT_ID: "client_ci",
        WORKOS_COOKIE_PASSWORD: "production-cookie-password-32-chars-min",
      }),
    );

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("WORKOS_API_KEY"),
        expect.stringContaining("WORKOS_CLIENT_ID"),
      ]),
    );
  });

  it("requires WORKOS_COOKIE_PASSWORD in production", () => {
    const result = evaluateApiStartupGuards(
      withOverrides({
        NODE_ENV: "production",
        APP_ENV: "production",
        WORKOS_API_KEY: "workos_live_ci_value",
        WORKOS_CLIENT_ID: "client_live_ci_value",
        WORKOS_COOKIE_PASSWORD: undefined,
      }),
    );

    expect(result.errors).toContainEqual(expect.stringContaining("WORKOS_COOKIE_PASSWORD"));
  });

  it("accepts WorkOS staging API keys in a production-built staging deploy", () => {
    const result = evaluateApiStartupGuards(
      withOverrides({
        NODE_ENV: "production",
        APP_ENV: "staging",
        WORKOS_API_KEY: "sk_test_workos_staging",
        WORKOS_CLIENT_ID: "client_staging_value",
        WORKOS_COOKIE_PASSWORD: "staging-cookie-password-32-chars-min",
      }),
    );

    expect(result.errors).not.toContainEqual(expect.stringContaining("WORKOS_API_KEY"));
  });

  it("warns when production replica count is not supplied by deployment config", () => {
    const result = evaluateApiStartupGuards(
      withOverrides({
        NODE_ENV: "production",
        APP_ENV: "production",
        API_REPLICA_COUNT: undefined,
        WORKOS_API_KEY: "workos_live_ci_value",
        WORKOS_CLIENT_ID: "client_live_ci_value",
        WORKOS_COOKIE_PASSWORD: "production-cookie-password-32-chars-min",
      }),
    );
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toContainEqual(
      expect.stringContaining("API_REPLICA_COUNT is unset in production"),
    );
  });

  it("accepts first-deploy single-replica production config", () => {
    const result = evaluateApiStartupGuards(
      withOverrides({
        NODE_ENV: "production",
        APP_ENV: "production",
        API_REPLICA_COUNT: 1,
        WORKOS_API_KEY: "workos_live_ci_value",
        WORKOS_CLIENT_ID: "client_live_ci_value",
        WORKOS_COOKIE_PASSWORD: "production-cookie-password-32-chars-min",
      }),
    );
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("requires S3 credentials when object store provider is s3", () => {
    const result = evaluateApiStartupGuards(
      withOverrides({
        OBJECT_STORE_PROVIDER: "s3",
        S3_ACCESS_KEY: undefined,
        S3_SECRET_KEY: undefined,
      }),
    );
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("S3_ACCESS_KEY: required when OBJECT_STORE_PROVIDER=s3"),
        expect.stringContaining("S3_SECRET_KEY: required when OBJECT_STORE_PROVIDER=s3"),
      ]),
    );
  });

  it.each([
    {
      label: "S3_ACCESS_KEY",
      overrides: {
        OBJECT_STORE_PROVIDER: "s3" as const,
        S3_ACCESS_KEY: "   ",
        S3_SECRET_KEY: "sk-secret",
      },
      expected: "S3_ACCESS_KEY: required when OBJECT_STORE_PROVIDER=s3",
    },
    {
      label: "S3_SECRET_KEY",
      overrides: {
        OBJECT_STORE_PROVIDER: "s3" as const,
        S3_ACCESS_KEY: "ak-test",
        S3_SECRET_KEY: "   ",
      },
      expected: "S3_SECRET_KEY: required when OBJECT_STORE_PROVIDER=s3",
    },
  ])("rejects whitespace-only live credential: $label", ({ overrides, expected }) => {
    const result = evaluateApiStartupGuards(withOverrides(overrides));
    expect(result.errors).toContainEqual(expect.stringContaining(expected));
  });
});
