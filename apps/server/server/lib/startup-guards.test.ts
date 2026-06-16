import { describe, expect, it } from "vitest";

import { type ApiStartupEnv, evaluateApiStartupGuards } from "./startup-guards";

const TEST_BASE_ENV: ApiStartupEnv = {
  NODE_ENV: "development",
  APP_ENV: "dev",
  DATABASE_URL: "postgresql://meridian:meridian@localhost:54422/postgres",
  MODEL_PROVIDER: "openai",
  backends: "local",
  ANTHROPIC_API_KEY: undefined,
  OPENAI_API_KEY: "sk-openai-real",
  OBJECT_STORE_PROVIDER: "local",
  S3_ACCESS_KEY: undefined,
  S3_SECRET_KEY: undefined,
  SUPABASE_URL: "http://127.0.0.1:54421",
  SUPABASE_ANON_KEY: "local-anon-key",
  WORKOS_API_KEY: "dev-workos-key",
  WORKOS_CLIENT_ID: "dev-workos-client",
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

  it("fails when live + MODEL_PROVIDER=auto has no real provider key", () => {
    const result = evaluateApiStartupGuards(
      withOverrides({
        backends: "live",
        MODEL_PROVIDER: "auto",
        OPENAI_API_KEY: "dev-openai-key",
        ANTHROPIC_API_KEY: undefined,
      }),
    );
    expect(result.errors).toContainEqual(
      expect.stringContaining("MODEL_PROVIDER=auto requires at least one real provider key"),
    );
  });

  it("allows local + MODEL_PROVIDER=auto without a real key", () => {
    const result = evaluateApiStartupGuards(
      withOverrides({
        backends: "local",
        MODEL_PROVIDER: "auto",
        OPENAI_API_KEY: "dev-openai-key",
        ANTHROPIC_API_KEY: undefined,
      }),
    );
    expect(result.errors).not.toContainEqual(
      expect.stringContaining("MODEL_PROVIDER=auto requires at least one real provider key"),
    );
  });

  it("accepts live MODEL_PROVIDER=auto when only DEEPSEEK_API_KEY is real", () => {
    const result = evaluateApiStartupGuards(
      withOverrides({
        backends: "live",
        MODEL_PROVIDER: "auto",
        ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: "dev-openai-key",
        DEEPSEEK_API_KEY: "sk-deepseek-real",
      }),
    );
    expect(result.errors).not.toContainEqual(
      expect.stringContaining("MODEL_PROVIDER=auto requires at least one real provider key"),
    );
  });

  it("rejects production Supabase placeholder configuration", () => {
    const result = evaluateApiStartupGuards(
      withOverrides({
        NODE_ENV: "production",
        SUPABASE_URL: "http://127.0.0.1:54421",
        SUPABASE_ANON_KEY: "dev-supabase-anon-key",
      }),
    );
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("SUPABASE_URL"),
        expect.stringContaining("SUPABASE_ANON_KEY"),
      ]),
    );
  });

  it("rejects production WorkOS placeholder credentials", () => {
    const result = evaluateApiStartupGuards(
      withOverrides({
        NODE_ENV: "production",
        APP_ENV: "production",
        WORKOS_API_KEY: "sk_test_placeholder",
        WORKOS_CLIENT_ID: "client_ci",
      }),
    );

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("WORKOS_API_KEY"),
        expect.stringContaining("WORKOS_CLIENT_ID"),
      ]),
    );
  });

  it("accepts WorkOS staging API keys in a production-built staging deploy", () => {
    const result = evaluateApiStartupGuards(
      withOverrides({
        NODE_ENV: "production",
        APP_ENV: "staging",
        WORKOS_API_KEY: "sk_test_workos_staging",
        WORKOS_CLIENT_ID: "client_staging_value",
        SUPABASE_URL: "https://project.supabase.co",
        SUPABASE_ANON_KEY: "prod-anon-key",
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
        SUPABASE_URL: "https://project.supabase.co",
        SUPABASE_ANON_KEY: "prod-anon-key",
        WORKOS_API_KEY: "workos_live_ci_value",
        WORKOS_CLIENT_ID: "client_live_ci_value",
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
        MODEL_PROVIDER: "openai",
        OPENAI_API_KEY: "sk-openai-real",
        SUPABASE_URL: "https://project.supabase.co",
        SUPABASE_ANON_KEY: "prod-anon-key",
        WORKOS_API_KEY: "workos_live_ci_value",
        WORKOS_CLIENT_ID: "client_live_ci_value",
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
