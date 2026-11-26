import { t } from "@lingui/core/macro";
import { isMeridianError, type MeridianError } from "@meridian/contracts/errors";

export class MeridianApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly source: MeridianError["source"];
  readonly details: MeridianError["details"];
  readonly envelope: MeridianError;
  readonly status: number | undefined;
  readonly headers: Headers | undefined;

  constructor(envelope: MeridianError, status?: number, headers?: Headers) {
    super(deletedDestinationCopy(envelope.code, envelope.details) ?? envelope.message);
    this.name = "MeridianApiError";
    this.code = envelope.code;
    this.retryable = envelope.retryable;
    this.source = envelope.source;
    this.details = envelope.details;
    this.envelope = envelope;
    this.status = status;
    this.headers = headers;
  }
}

export function isMeridianApiError(value: unknown): value is MeridianApiError {
  return value instanceof MeridianApiError;
}

export function meridianApiErrorFromPayload(
  payload: unknown,
  status?: number,
  headers?: Headers,
): MeridianApiError | null {
  if (!payload || typeof payload !== "object") return null;

  if (isMeridianError(payload)) {
    return new MeridianApiError(payload, status, headers);
  }

  const wrapped = payload as { kind?: unknown; error?: unknown };
  if (wrapped.kind === "error" && isMeridianError(wrapped.error)) {
    return new MeridianApiError(wrapped.error, status, headers);
  }

  // Nitro/H3 serializes `createError({ data: envelope })` under `data` while
  // retaining its own status/message fields at the top level.
  const h3 = payload as { data?: unknown };
  if (isMeridianError(h3.data)) {
    return new MeridianApiError(h3.data, status, headers);
  }

  return null;
}

export function deletedDestinationCopy(
  code: string,
  details?: MeridianError["details"],
): string | null {
  if (
    code === "project_deleted" ||
    (code === "thread_deleted" &&
      details &&
      typeof details === "object" &&
      !Array.isArray(details) &&
      details.projectDeleted === true)
  )
    return t`This project was deleted.`;
  if (code === "thread_deleted") return t`This chat was deleted.`;
  return null;
}
