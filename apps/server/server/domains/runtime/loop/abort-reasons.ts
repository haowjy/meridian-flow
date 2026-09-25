/** Internal abort causes that affect turn finalization. */
import { meridianErrorFromSystem } from "@meridian/contracts/interrupt";

export class ServerRestartingError extends Error {
  readonly code = "server_restarting";

  constructor() {
    super("The server is restarting. Retry this message shortly.");
    this.name = "ServerRestartingError";
  }
}

export function isShutdownAbort(signal: AbortSignal | undefined): boolean {
  return signal?.reason instanceof ServerRestartingError;
}

export function shutdownTurnError() {
  return meridianErrorFromSystem(
    "runtime_error",
    "The server is restarting. Retry this message shortly.",
    true,
  );
}
