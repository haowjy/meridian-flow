/**
 * The package fetch port against live GitHub: each shared budget aborts with its own name when
 * its limit is lowered, and the tar reader counts bytes as they stream (a 4 MB repository trips
 * a 1 MB expanded limit without reading the rest).
 *
 *   pnpm exec tsx tools/qa/probes/package-fetch/run.mts
 *
 * Pins implementation decisions: the budget names `download`, `expanded`, `entries`, `wall-time`.
 */
import assert from "node:assert/strict";
import {
  createFetchBudget,
  createGithubPackageFetcher,
  FETCH_LIMITS,
  FetchBudgetError,
  type FetchLimits,
} from "../../../../apps/server/server/domains/packages/index.js";

const url = "https://github.com/haowjy/creative-writing-skills";
const fetcher = createGithubPackageFetcher({ token: process.env.FLOW_GITHUB_TOKEN });

const trips: [string, Partial<FetchLimits>][] = [
  ["download", { downloadBytes: 100_000 }],
  ["expanded", { expandedBytes: 1_000_000 }],
  ["entries", { entries: 100 }],
  ["wall-time", { wallTimeMs: 1 }],
];

for (const [name, limits] of trips) {
  const budget = createFetchBudget({ ...FETCH_LIMITS, ...limits });
  const error = await fetcher.fetchTree({ url }, budget).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof FetchBudgetError, `${name}: expected a budget error, got ${error}`);
  assert.equal(error.budget, name);
  console.log(`${name}: ${error.message}`, budget.used());
}
