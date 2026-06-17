import { describe, expect, it } from "vitest";
import { DEV_DATABASES, resolveDatabaseUrl } from "../lib/dev-env";

describe("dev-env", () => {
  it("registers Meridian's local Postgres database", () => {
    expect(DEV_DATABASES.map((db) => db.envVar)).toEqual(["DATABASE_URL"]);
    expect(DEV_DATABASES[0]?.label).toBe("Meridian local Postgres");
  });

  it("does not rewrite database URLs per worktree", () => {
    const baseUrl = "postgresql://postgres:postgres@127.0.0.1:54422/meridian";
    expect(resolveDatabaseUrl({ baseUrl })).toBe(baseUrl);
  });
});
