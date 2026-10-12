/** Typed CLI failures and the exit-code contract agents branch on. */

export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  notFound: 3,
  unavailable: 4,
  cancelled: 5,
  interrupt: 8,
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
  | "interrupt_pending"
  | "timeout"
  | "protocol";

const EXIT_BY_CODE: Record<CliErrorCode, ExitCode> = {
  usage: EXIT.usage,
  not_found: EXIT.notFound,
  unavailable: EXIT.unavailable,
  http_error: EXIT.failed,
  run_failed: EXIT.failed,
  cancelled: EXIT.cancelled,
  interrupt_pending: EXIT.interrupt,
  timeout: EXIT.timeout,
  protocol: EXIT.failed,
};

export class CliError extends Error {
  readonly code: CliErrorCode;
  readonly hint: string | undefined;
  readonly details: unknown;

  constructor(code: CliErrorCode, message: string, options?: { hint?: string; details?: unknown }) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.hint = options?.hint;
    this.details = options?.details;
  }

  get exitCode(): ExitCode {
    return EXIT_BY_CODE[this.code];
  }
}

export function usageError(message: string, hint?: string): CliError {
  return new CliError("usage", message, { hint });
}
