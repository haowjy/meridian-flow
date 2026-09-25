import { describe, expect, it } from "vitest";
import {
  type ApiStartupEnv,
  evaluateApiStartupGuards,
  exitOnStartupGuardFailure,
} from "./startup-guards.js";

const baseConfig: ApiStartupEnv = {
  NODE_ENV: "development",
  APP_ENV: "staging",
  DATABASE_URL: "postgres://service:secret@db.example.net:5432/meridian",
  OBJECT_STORE_PROVIDER: "s3",
  S3_BUCKET: "meridian-staging",
  S3_ACCESS_KEY: "real-access-key",
  S3_SECRET_KEY: "real-secret-key",
  WORKOS_API_KEY: "sk_test_staging-key",
  DEEPSEEK_API_KEY: "live-model-key",
  WORKOS_CLIENT_ID: "client_staging",
  WORKOS_COOKIE_PASSWORD: "a-secure-cookie-password-of-32-chars",
  WORKOS_REDIRECT_URI: "https://app.example.net/api/auth/callback",
  MERIDIAN_BACKENDS: "live",
  API_REPLICA_COUNT: 1,
  DURABLE_EVENT_BACKEND: "none",
};

describe("staging and production startup guards", () => {
  it("emits and flushes a failed guard before exiting non-zero", async () => {
    const order: string[] = [];
    const emitted: unknown[] = [];
    const eventSink = {
      emit(event: unknown) {
        emitted.push(event);
        order.push(`emit:${(event as { name: string }).name}`);
      },
      emitBatch() {},
      async flush() {
        order.push("flush");
      },
    };

    await exitOnStartupGuardFailure(new Error("invalid config"), {
      eventSink,
      writeError(message) {
        order.push(`stderr:${message}`);
      },
      exit(code) {
        order.push(`exit:${code}`);
      },
    });

    expect(order).toEqual([
      "emit:startup_guard.failed",
      "stderr:invalid config",
      "flush",
      "exit:1",
    ]);
    expect(emitted[0]).toMatchObject({ name: "startup_guard.failed" });
  });

  it("rejects dev placeholders based on APP_ENV even when NODE_ENV is development", () => {
    const outcome = evaluateApiStartupGuards({
      ...baseConfig,
      DATABASE_URL: "postgres://localhost/meridian",
      OBJECT_STORE_PROVIDER: "local",
      S3_BUCKET: undefined,
      S3_PUBLIC_ENDPOINT: "http://minio.localhost:9000",
      WORKOS_API_KEY: "dev-workos-key",
      WORKOS_CLIENT_ID: "dev-workos-client",
      WORKOS_COOKIE_PASSWORD: "",
      MERIDIAN_BACKENDS: "local",
    });

    expect(outcome.errors.join("\n")).toContain("MERIDIAN_BACKENDS");
    expect(outcome.errors.join("\n")).toContain("OBJECT_STORE_PROVIDER");
    expect(outcome.errors.join("\n")).toContain("DATABASE_URL");
    expect(outcome.errors.join("\n")).toContain("S3_PUBLIC_ENDPOINT");
    expect(outcome.errors.join("\n")).toContain("WORKOS_API_KEY");
    expect(outcome.errors.join("\n")).toContain("WORKOS_CLIENT_ID");
    expect(outcome.errors.join("\n")).toContain("WORKOS_COOKIE_PASSWORD");
    expect(outcome.errors.join("\n")).toContain("S3_BUCKET");
  });

  it("rejects unsupported postgres startup parameters and Neon pooler URLs", () => {
    const channelBinding = evaluateApiStartupGuards({
      ...baseConfig,
      DATABASE_URL: "postgres://u:p@db.example/meridian?sslmode=require&channel_binding=require",
    });
    expect(channelBinding.errors.join("\n")).toContain("remove channel_binding");

    const pooler = evaluateApiStartupGuards({
      ...baseConfig,
      DATABASE_URL: "postgres://u:p@ep-pooler.example.neon.tech/db?sslmode=require",
    });
    expect(pooler.errors.join("\n")).toContain("direct endpoint");
  });

  it("rejects mock-only model setup for a live APP_ENV", () => {
    const outcome = evaluateApiStartupGuards({
      ...baseConfig,
      MODEL_PROVIDER: "mock",
      DEEPSEEK_API_KEY: "dev-deepseek-key",
    });

    expect(outcome.errors.join("\n")).toContain("MODEL_PROVIDER");
  });

  it("accepts complete staging configuration independent of NODE_ENV", () => {
    expect(evaluateApiStartupGuards(baseConfig).errors).toEqual([]);
  });
});
