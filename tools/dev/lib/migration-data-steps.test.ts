/** The data-step registry is strict both ways, and the repository keeps its one step anchored. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { ELIGIBLE_BRANCH_PREDICATE } from "@meridian/database/migration-steps";
import { describe, expect, it } from "vitest";
import {
  MIGRATION_DATA_STEPS,
  type MigrationDataStep,
  planDataSteps,
  stepKey,
} from "./migration-data-steps";
import { readMigrationHistory } from "./migration-history";

const step = (id: string, version: number): MigrationDataStep => ({
  id,
  version,
  preflight: async () => {},
  run: async () => {},
});
const entry = (tag: string, sql: string, idx = 0) =>
  ({ idx, tag, when: idx, breakpoints: true, hash: tag, sql: Buffer.from(sql) }) as const;

describe("data-step plan", () => {
  it("refuses an unregistered or mismarked pending marker and a doubled anchor, and runs only pending anchors", () => {
    const marked = entry("0001_anchor", "-- data-step: convert@1\nSELECT 1;", 1);
    const plain = entry("0000_plain", "SELECT 1;");
    const pending = new Set(["0001_anchor"]);
    expect(planDataSteps([step("convert", 1)], [plain, marked], pending)).toEqual({
      issues: [],
      due: [{ step: expect.objectContaining({ id: "convert" }), anchorTag: "0001_anchor" }],
    });
    expect(planDataSteps([], [plain, marked], pending).issues).toEqual([
      "0001_anchor is marked convert@1 but no data step is registered for it",
    ]);
    expect(planDataSteps([step("convert", 2)], [plain, marked], pending).issues).toEqual([
      "0001_anchor is marked convert@1 but the registered step is convert@2",
    ]);
    // An applied marker of an older version is history, not a refusal: a later release bumped the step.
    expect(planDataSteps([step("convert", 2)], [plain, marked], new Set()).issues).toEqual([]);
    const twice = entry("0002_again", "-- data-step: convert@1\nSELECT 1;", 2);
    expect(planDataSteps([step("convert", 1)], [marked, twice], new Set()).issues).toHaveLength(1);
    // A registered step with no marker in the given history has nothing pending (a staged prefix).
    expect(planDataSteps([step("convert", 1)], [plain], new Set(["0000_plain"]))).toEqual({
      issues: [],
      due: [],
    });
  });

  it("anchors every registered step once in the repository, first line, on the converter's own predicate", () => {
    const directory = path.resolve(
      import.meta.dirname,
      "../../../packages/database/src/migrations",
    );
    const history = readMigrationHistory(directory);
    for (const registered of MIGRATION_DATA_STEPS) {
      const plan = planDataSteps(
        MIGRATION_DATA_STEPS,
        history.entries,
        new Set(history.entries.map((e) => e.tag)),
      );
      expect(plan.issues).toEqual([]);
      const anchors = plan.due.filter((due) => due.step === registered);
      expect(anchors).toHaveLength(1);
      const sql = readFileSync(path.join(directory, `${anchors[0]?.anchorTag}.sql`), "utf8");
      expect(sql.split("\n")[0]).toBe(`-- data-step: ${stepKey(registered)}`);
      // B3's guard embeds the predicate the converter selects with, so they cannot drift apart.
      expect(sql).toContain(ELIGIBLE_BRANCH_PREDICATE);
    }
  });
});
