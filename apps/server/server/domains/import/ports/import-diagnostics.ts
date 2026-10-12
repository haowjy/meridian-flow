/** Raw failures stay in server observability, never in the writer-facing report. */
import type { ImportFailureReason } from "@meridian/contracts";
export interface ImportDiagnostics {
  failed(input: {
    importId: string;
    entryId: number;
    code: ImportFailureReason;
    cause: unknown;
  }): void;
  /** Object cleanup failed; the periodic sweep retries it. */
  sweepFailed(input: { importId: string; entryId: number; cause: unknown }): void;
}
