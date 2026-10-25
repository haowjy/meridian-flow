/**
 * Test budget guard: the expanded case count per test file may not grow, and a
 * run may not exceed its wall-clock or memory ceiling.
 *
 * The suite is held by a ratchet rather than a target count. A count is
 * collection-based (`allTests()` sees every collected case, including skipped
 * ones and every `it.each` row). Comparison is per file, not per run, because
 * CI shards the unit suite across jobs and no job sees the whole suite.
 *
 * Growth is not forbidden, it is made deliberate: refresh the baseline with
 * `TEST_BUDGET_UPDATE=1 pnpm test` so the increase is a reviewable line in the
 * diff rather than silent drift.
 *
 * Wall time is reported on every run and NEVER blocks. It is a property of the
 * machine and of the worker count as much as of the suite: the identical 2,414
 * cases measured 53s to 85s on one shared host, and the DB suite runs 89s at
 * four local workers against 266-322s when CI still ran it serially. A hard gate on that number
 * fails on configuration and runner load rather than on a regression, so it
 * warns. The comparison value comes from TEST_DURATION_REFERENCE_SECONDS.
 *
 * Memory is sampled across the whole run and DOES block on every run, CI or
 * not: unlike wall time it is a property of the suite rather than of the load
 * on the machine. The sample covers this process and, on Linux, every
 * descendant, so a `forks` pool's child processes count as well. Override with
 * TEST_MEMORY_CEILING_MB.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative as relativePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { Reporter, TestModule } from "vitest/node";

const BASELINE_PATH = fileURLToPath(new URL("./test-case-baseline.json", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_DURATION_REFERENCE_SECONDS = 150;
const DEFAULT_MEMORY_CEILING_MB = 4096;
const SAMPLE_INTERVAL_MS = 250;
const startedAt = performance.now();

function rssOf(pid: number): number {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
    return match ? Number(match[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

function childPids(pid: number): number[] {
  try {
    const children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8");
    return children.trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

/** This process plus every descendant, so a forks pool's children are counted. */
function treeRss(): number {
  if (process.platform !== "linux") return process.memoryUsage.rss();
  let total = 0;
  const frontier = [process.pid];
  while (frontier.length > 0) {
    const pid = frontier.pop() as number;
    total += rssOf(pid);
    for (const child of childPids(pid)) frontier.push(child);
  }
  return total;
}

type Baseline = {
  /** Expanded case count per test file, repo-relative. */
  files: Record<string, number>;
};

function relative(moduleId: string): string {
  return moduleId.startsWith(REPO_ROOT)
    ? moduleId.slice(REPO_ROOT.length)
    : relativePath(REPO_ROOT, moduleId);
}

function readBaseline(): Baseline {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
  } catch {
    return { files: {} };
  }
}

export default class TestBudgetReporter implements Reporter {
  private observed = new Map<string, number>();
  private peakRssBytes = 0;
  private readonly sampler: NodeJS.Timeout;

  constructor() {
    this.peakRssBytes = treeRss();
    this.sampler = setInterval(() => {
      this.peakRssBytes = Math.max(this.peakRssBytes, treeRss());
    }, SAMPLE_INTERVAL_MS);
    this.sampler.unref();
  }

  onTestRunEnd(modules: ReadonlyArray<TestModule>): void {
    clearInterval(this.sampler);
    const baseline = readBaseline();
    const updating = process.env.TEST_BUDGET_UPDATE === "1";
    const failures: string[] = [];

    for (const module of modules) {
      const count = [...module.children.allTests()].length;
      if (count === 0) continue;
      const file = relative(module.moduleId);
      this.observed.set(file, count);
      if (updating) continue;
      const allowed = baseline.files[file];
      if (allowed === undefined) {
        failures.push(`${file}: new test file with ${count} case(s), not in the baseline`);
      } else if (count > allowed) {
        failures.push(`${file}: grew from ${allowed} to ${count} case(s)`);
      }
    }

    if (updating) {
      // Merge rather than replace: a unit-only refresh must not drop the DB
      // entries, and a file that no longer exists should fall out of the
      // baseline instead of lingering as a stale allowance.
      const merged = new Map(Object.entries(baseline.files));
      for (const file of merged.keys()) {
        if (!existsSync(join(REPO_ROOT, file))) merged.delete(file);
      }
      for (const [file, count] of this.observed) merged.set(file, count);
      const files = Object.fromEntries(
        [...merged.entries()].sort(([a], [b]) => a.localeCompare(b)),
      );
      writeFileSync(BASELINE_PATH, `${JSON.stringify({ files }, null, 2)}\n`);
      const total = Object.values(files).reduce((sum, n) => sum + n, 0);
      process.stderr.write(
        `\nTest budget: wrote ${BASELINE_PATH} (${Object.keys(files).length} files, ${total} cases).\n`,
      );
      return;
    }

    const grown = this.observed.size > 0 ? this.summary(baseline) : undefined;
    const elapsed = (performance.now() - startedAt) / 1_000;
    const reference = Number(
      process.env.TEST_DURATION_REFERENCE_SECONDS ?? DEFAULT_DURATION_REFERENCE_SECONDS,
    );

    if (grown) process.stderr.write(`\nTest budget: ${grown}\n`);
    const duration = `Test duration: ${elapsed.toFixed(1)}s / ${reference}s reference`;
    if (elapsed > reference) {
      process.stderr.write(
        `::warning::${duration} — ${(elapsed - reference).toFixed(1)}s over. Wall time tracks the machine and the worker count, not only the suite, so it does not fail the run. Treat it as a signal to check what changed.\n`,
      );
    } else {
      process.stderr.write(`${duration}\n`);
    }

    // Memory blocks, unlike duration: it is a property of the suite, not of how
    // busy the machine is.
    const peakMb = Math.round(this.peakRssBytes / (1024 * 1024));
    const memoryCeilingMb = Number(process.env.TEST_MEMORY_CEILING_MB ?? DEFAULT_MEMORY_CEILING_MB);
    const memory = `Peak memory: ${peakMb} MB / ${memoryCeilingMb} MB ceiling`;
    if (peakMb > memoryCeilingMb) failures.push(`${memory} - over the ceiling`);
    else process.stderr.write(`${memory}\n`);

    if (failures.length > 0) {
      throw new Error(
        [
          "Test budget guard failed:",
          ...failures.map((failure) => `  - ${failure}`),
          "If the growth is intended, refresh the baseline with `TEST_BUDGET_UPDATE=1 pnpm test` in the same change.",
        ].join("\n"),
      );
    }
  }

  /** Files that shrank, so a baseline refresh stays visible rather than forgotten. */
  private summary(baseline: Baseline): string | undefined {
    const shrank: string[] = [];
    for (const [file, count] of this.observed) {
      const allowed = baseline.files[file];
      if (allowed !== undefined && count < allowed) shrank.push(`${file}: ${allowed} -> ${count}`);
    }
    if (shrank.length === 0) return undefined;
    return `${shrank.length} file(s) shrank; refresh the baseline to lock the reduction in:\n${shrank
      .slice(0, 10)
      .map((entry) => `  ${entry}`)
      .join("\n")}${shrank.length > 10 ? `\n  ... and ${shrank.length - 10} more` : ""}`;
  }
}
