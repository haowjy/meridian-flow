/** Raw failures stay in server observability, never in the writer-facing report. */
import type { ImportFailureReason } from "@meridian/contracts";
export interface ImportDiagnostics {
  failed(input: {
    importId: string;
    entryId: number;
    code: ImportFailureReason;
    cause: unknown;
  }): void;
}
