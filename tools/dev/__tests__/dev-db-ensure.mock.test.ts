import { beforeEach, describe, expect, it, vi } from "vitest";

const connectTargets: string[] = [];
const mockEnd = vi.fn().mockResolvedValue(undefined);

vi.mock("postgres", () => ({
  default: vi.fn((connString: string) => {
    connectTargets.push(connString);

    const query = async () => {
      if (connString.endsWith("/existing_db")) {
        return [{ "?column?": 1 }];
      }
      if (connString.includes("db.example.com") && connString.endsWith("/missing_remote")) {
        const err = Object.assign(new Error('database "missing_remote" does not exist'), {
          code: "3D000",
        });
        throw err;
      }
      throw new Error(`unexpected postgres mock connection: ${connString}`);
    };

    return Object.assign(query, {
      unsafe: vi.fn(),
      end: mockEnd,
    });
  }),
}));

const { ensureDatabaseForUrl } = await import("../lib/dev-db");

describe("ensureDatabaseForUrl (mocked)", () => {
  beforeEach(() => {
    connectTargets.length = 0;
    mockEnd.mockClear();
  });

  it("connects to the target database first when it already exists", async () => {
    const databaseUrl = "postgresql://postgres:postgres@127.0.0.1:54422/existing_db";

    await expect(ensureDatabaseForUrl(databaseUrl)).resolves.toEqual({
      targetDb: "existing_db",
      created: false,
    });

    expect(connectTargets).toEqual([databaseUrl]);
    expect(connectTargets.some((url) => url.endsWith("/postgres"))).toBe(false);
  });

  it("refuses auto-create on non-local hosts when the database is missing", async () => {
    const databaseUrl = "postgresql://postgres:postgres@db.example.com:5432/missing_remote";

    await expect(ensureDatabaseForUrl(databaseUrl)).rejects.toThrow(
      /Database "missing_remote" does not exist.*Auto-create is only available/,
    );

    expect(connectTargets).toEqual([databaseUrl]);
    expect(connectTargets.some((url) => url.endsWith("/postgres"))).toBe(false);
  });
});
