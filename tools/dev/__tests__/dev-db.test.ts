import { describe, expect, it } from "vitest";
import { isReservedDatabase, parseTargetDatabase, validateDbName } from "../lib/dev-db";

describe("dev-db", () => {
  it("parses target database names", () => {
    expect(parseTargetDatabase("postgresql://u:p@localhost:54422/postgres").targetDb).toBe(
      "postgres",
    );
  });

  it("rejects unsafe database names", () => {
    expect(() => validateDbName("bad/name")).toThrow(/unsafe/);
  });

  it("treats postgres and main DB names as reserved", () => {
    expect(isReservedDatabase("postgres", [])).toBe(true);
    expect(isReservedDatabase("meridian", ["meridian"])).toBe(true);
  });
});
