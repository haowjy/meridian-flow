import { meridianErrorFromSystem } from "@meridian/contracts/protocol";
import { isError } from "nitro/h3";
import { WorkLockedError } from "../domains/projects/index.js";
import {
  HTTP_INTERRUPT_ENVELOPE_KEY,
  isHttpInterruptEnvelope,
  throwHttpInterrupt,
} from "../shared/interrupt-boundary.js";
import { WorkLifecycleUnavailableError } from "../shared/work-lifecycle-lock.js";

export function throwWorkMutationHttpError(error: unknown): never {
  if (error instanceof WorkLockedError) {
    throwHttpInterrupt(meridianErrorFromSystem(error.code, error.message), 400);
  }
  if (error instanceof WorkLifecycleUnavailableError) {
    const archived = error.state === "archived";
    throwHttpInterrupt(
      meridianErrorFromSystem(
        archived ? "work_archived" : "work_not_found",
        archived ? "This Work is archived and read-only." : "Work not found.",
      ),
      archived ? 409 : 404,
    );
  }
  if (isError(error) && error.statusCode === 404) {
    const data = error.data;
    if (
      data &&
      typeof data === "object" &&
      HTTP_INTERRUPT_ENVELOPE_KEY in data &&
      isHttpInterruptEnvelope(data[HTTP_INTERRUPT_ENVELOPE_KEY])
    )
      throw error;
    throwHttpInterrupt(meridianErrorFromSystem("work_not_found", "Work not found."), 404);
  }
  throw error;
}
