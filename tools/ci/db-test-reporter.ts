/** Vitest guard preventing an absent or entirely skipped DB run from passing CI. */
import type { Reporter, TestModule } from "vitest/node";

export default class DbTestReporter implements Reporter {
  onTestRunEnd(modules: ReadonlyArray<TestModule>): void {
    const dbModules = modules.filter((module) => module.moduleId.endsWith(".db.test.ts"));
    const executed = dbModules.some((module) =>
      [...module.children.allTests()].some((test) => {
        const state = test.result().state;
        return state === "passed" || state === "failed";
      }),
    );
    if (!executed) {
      throw new Error("DB test guard: expected discovered, executed DB tests; none ran.");
    }
  }
}
