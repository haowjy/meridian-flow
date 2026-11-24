export class ExecutionReportConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionReportConflictError";
  }
}
