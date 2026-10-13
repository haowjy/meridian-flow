/** Canonical writer-facing HTTP envelopes for Work metadata and archive lifecycle refusals. */
import { meridianErrorFromSystem } from "@meridian/contracts/protocol";
import { isError } from "nitro/h3";
import { WorkLifecycleUnavailableError, WorkNameConflictError } from "../domains/projects/index.js";
import {
  HTTP_INTERRUPT_ENVELOPE_KEY,
  isHttpInterruptEnvelope,
  throwHttpInterrupt,
} from "../shared/interrupt-boundary.js";

export function throwWorkMutationHttpError(error: unknown): never {
  if (error instanceof WorkNameConflictError) {
    throwHttpInterrupt(meridianErrorFromSystem("work_name_conflict", error.message), 409);
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
    // Owner gates already carry the proof; don't replace a deleted project with a missing Work.
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
