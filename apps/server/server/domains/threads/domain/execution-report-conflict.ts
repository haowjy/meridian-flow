/** A report compare-and-set rejected competing content, not a storage failure. */
export class ExecutionReportConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionReportConflictError";
  }
}
