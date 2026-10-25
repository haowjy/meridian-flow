/** Typed CLI failures and the exit-code contract agents branch on. */

import { classifyCommandFailure, type FailureOccurrence } from "@meridian/contracts/failures";

export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  notFound: 3,
  unavailable: 4,
  cancelled: 5,
  unproven: 6,
  timeout: 124,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export type CliErrorCode =
  | "usage"
  | "not_found"
  | "unavailable"
  | "http_error"
  | "run_failed"
  | "cancelled"
  | "timeout"
  | "protocol"
  | "unproven";

const EXIT_BY_CODE: Record<CliErrorCode, ExitCode> = {
  usage: EXIT.usage,
  not_found: EXIT.notFound,
  unavailable: EXIT.unavailable,
  http_error: EXIT.failed,
  run_failed: EXIT.failed,
  cancelled: EXIT.cancelled,
  timeout: EXIT.timeout,
  protocol: EXIT.failed,
  unproven: EXIT.unproven,
};

export class CliError extends Error {
  readonly occurrence: FailureOccurrence;
  readonly code: CliErrorCode;
  readonly hint: string | undefined;
  readonly details: unknown;
  readonly httpStatus: number | undefined;

  constructor(
    code: CliErrorCode,
    message: string,
    options?: {
      hint?: string;
      details?: unknown;
      httpStatus?: number;
      occurrence?: FailureOccurrence;
      malformedResponse?: boolean;
    },
  ) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.hint = options?.hint;
    this.details = options?.details;
    this.httpStatus = options?.httpStatus;
    this.occurrence = options?.occurrence ?? {
      occurrenceId: crypto.randomUUID(),
      failure:
        code === "usage"
          ? {
              category: "command",
              source: "validation",
              actionable: true,
              cause: { code: "validation" },
            }
          : classifyCommandFailure({
              kind:
                options?.httpStatus && options.httpStatus >= 400 && options.httpStatus < 500
                  ? "refused"
                  : "lost",
              status: options?.httpStatus,
              ...(options?.malformedResponse || code === "protocol"
                ? { code: "malformed_response" }
                : {}),
            }),
    };
  }

  get exitCode(): ExitCode {
    return EXIT_BY_CODE[this.code];
  }
}

export function usageError(message: string, hint?: string): CliError {
  return new CliError("usage", message, { hint });
}
