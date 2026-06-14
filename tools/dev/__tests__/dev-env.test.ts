import { describe, expect, it } from "vitest";
import { DEV_DATABASES, resolveDatabaseUrl } from "../lib/dev-env";

describe("dev-env", () => {
  it("registers Meridian's Supabase Postgres database", () => {
    expect(DEV_DATABASES.map((db) => db.envVar)).toEqual(["DATABASE_URL"]);
  });

  it("does not rewrite Supabase database URLs per worktree", () => {
    const baseUrl = "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
    expect(resolveDatabaseUrl({ baseUrl })).toBe(baseUrl);
  });
});
