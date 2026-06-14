/**
 * Bash-tool timeout math. The tool executor owns the outer deadline; these
 * helpers derive the child command's remaining wall-clock budget.
 */
export function resolveBashTimeoutSeconds(timeout: unknown): number {
  const requested = typeof timeout === "number" && Number.isFinite(timeout) ? timeout : 120;
  return Math.max(1, Math.min(Math.trunc(requested), 600));
}

export function remainingBashTimeoutSeconds(requestedSeconds: number, startedAtMs: number): number {
  const elapsedSeconds = (Date.now() - startedAtMs) / 1000;
  return Math.max(1, Math.min(requestedSeconds - elapsedSeconds, 600));
}
