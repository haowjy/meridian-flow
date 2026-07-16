/** Vitest guard preventing an absent or entirely skipped DB run from passing CI. */
import type { File, Reporter } from "vitest";

export default class DbTestReporter implements Reporter {
  onFinished(files: File[] = []): void {
    const tests = files.flatMap((file) => file.tasks).filter((task) => task.type === "test");
    const executed = tests.filter(
      (test) => test.result?.state === "pass" || test.result?.state === "fail",
    );
    if (files.length === 0 || tests.length === 0 || executed.length === 0) {
      throw new Error("DB test guard: expected discovered, executed DB tests; none ran.");
    }
  }
}
