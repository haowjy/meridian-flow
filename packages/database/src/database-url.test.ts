import { describe, expect, it } from "vitest";
import { assertSupportedDatabaseUrl } from "./database-url.js";

describe("assertSupportedDatabaseUrl", () => {
  it("rejects channel_binding and explains the supported TLS option", () => {
    expect(() =>
      assertSupportedDatabaseUrl(
        "postgres://u:p@db.example/meridian?sslmode=require&channel_binding=require",
      ),
    ).toThrow(/remove channel_binding.*keep sslmode=require/);
  });

  it("allows sslmode=require on a direct Neon endpoint", () => {
    expect(() =>
      assertSupportedDatabaseUrl(
        "postgres://u:p@ep.example.us-east-1.aws.neon.tech/db?sslmode=require",
        "production",
      ),
    ).not.toThrow();
  });

  it("rejects Neon pooler hosts only in live environments", () => {
    const url = "postgres://u:p@ep-pooler.example.us-east-1.aws.neon.tech/db?sslmode=require";
    expect(() => assertSupportedDatabaseUrl(url, "staging")).toThrow(/direct endpoint/);
    expect(() => assertSupportedDatabaseUrl(url, "production")).toThrow(/direct endpoint/);
    expect(() => assertSupportedDatabaseUrl(url, "dev")).not.toThrow();
  });
});
