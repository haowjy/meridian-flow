import { describe, expect, it } from "vitest";
import {
  dropDatabaseForUrl,
  ensureDatabaseForUrl,
  isLocalDevPostgres,
  isReservedDatabase,
  LOCAL_DEV_POSTGRES_PORT,
  parseTargetDatabase,
  resetSchemaForUrl,
  validateDbName,
} from "../lib/dev-db";

describe("dev-db", () => {
  it("parses target database names", () => {
    expect(parseTargetDatabase("postgresql://u:p@localhost:54422/meridian").targetDb).toBe(
      "meridian",
    );
  });

  it("rejects unsafe database names", () => {
    expect(() => validateDbName("bad/name")).toThrow(/unsafe/);
  });

  it("treats postgres, meridian, and main DB names as reserved", () => {
    expect(isReservedDatabase("postgres", [])).toBe(true);
    expect(isReservedDatabase("meridian", [])).toBe(true);
    expect(isReservedDatabase("meridian", ["meridian"])).toBe(true);
  });

  it("recognizes the canonical local dev Postgres endpoint", () => {
    expect(isLocalDevPostgres("postgresql://postgres:postgres@127.0.0.1:54422/meridian")).toBe(
      true,
    );
    expect(isLocalDevPostgres("postgresql://postgres:postgres@localhost:54422/meridian")).toBe(
      true,
    );
    expect(isLocalDevPostgres("postgresql://postgres:postgres@db.example.com:5432/meridian")).toBe(
      false,
    );
    expect(isLocalDevPostgres("postgresql://postgres:postgres@127.0.0.1:5432/meridian")).toBe(
      false,
    );
    expect(isLocalDevPostgres("postgresql://postgres:postgres@127.0.0.1/meridian")).toBe(false);
    expect(LOCAL_DEV_POSTGRES_PORT).toBe(54422);
  });

  it("refuses to drop databases on non-local hosts", async () => {
    await expect(
      dropDatabaseForUrl("postgresql://postgres:postgres@db.example.com:5432/meridian_test", []),
    ).rejects.toThrow(/non-local dev Postgres endpoint/);
  });

  it("refuses to drop databases on local host with wrong port", async () => {
    await expect(
      dropDatabaseForUrl("postgresql://postgres:postgres@127.0.0.1:5432/meridian_test", []),
    ).rejects.toThrow(/non-local dev Postgres endpoint/);
  });

  it("refuses to reset schema on non-local hosts", async () => {
    await expect(
      resetSchemaForUrl("postgresql://postgres:postgres@db.example.com:5432/meridian"),
    ).rejects.toThrow(/non-local dev Postgres endpoint/);
  });

  it("refuses to reset schema on local host with wrong port", async () => {
    await expect(
      resetSchemaForUrl("postgresql://postgres:postgres@127.0.0.1:5432/meridian"),
    ).rejects.toThrow(/non-local dev Postgres endpoint/);
  });

  it("refuses to drop reserved databases", async () => {
    await expect(
      dropDatabaseForUrl("postgresql://postgres:postgres@127.0.0.1:54422/postgres", []),
    ).rejects.toThrow(/reserved database/);
    await expect(
      dropDatabaseForUrl("postgresql://postgres:postgres@127.0.0.1:54422/meridian", []),
    ).rejects.toThrow(/reserved database/);
    await expect(
      dropDatabaseForUrl("postgresql://postgres:postgres@127.0.0.1:54422/meridian", ["meridian"]),
    ).rejects.toThrow(/reserved database/);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("dev-db integration", () => {
  const adminUrl = process.env.DATABASE_URL as string;
  const throwawayDb = "meridian_dev_db_contract_test";
  const throwawayUrl = (() => {
    const url = new URL(adminUrl);
    url.pathname = `/${throwawayDb}`;
    return url.toString();
  })();

  it("creates a missing database and treats duplicate create as idempotent", async () => {
    await dropDatabaseForUrl(throwawayUrl, []).catch(() => undefined);
    const first = await ensureDatabaseForUrl(throwawayUrl);
    expect(first).toEqual({ targetDb: throwawayDb, created: true });
    const second = await ensureDatabaseForUrl(throwawayUrl);
    expect(second).toEqual({ targetDb: throwawayDb, created: false });
    await dropDatabaseForUrl(throwawayUrl, []);
  });
});
