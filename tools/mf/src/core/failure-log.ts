/** CLI error delivery never changes its exit code or recursively reports ingest failure. */
import type { FailureOccurrence } from "@meridian/contracts/failures";
import { authIdentitySchema } from "@meridian/contracts/protocol";
import { jsonResponse, type Session, unknownJsonResponse } from "./session";

export async function sendFailure(session: Session, occurrence: FailureOccurrence): Promise<void> {
  try {
    const me = await session.request("GET", "/api/auth/me", undefined, {
      timeoutMs: 500,
      decode: jsonResponse(authIdentitySchema),
    });
    await session.request(
      "POST",
      "/api/diagnostics/failures",
      { accountId: me.user.userId, records: [{ ...occurrence, phase: "recorded" }] },
      { timeoutMs: 500, decode: unknownJsonResponse },
    );
  } catch {
    // The command's stderr already carries the failure. Diagnostics have no recovery loop.
  }
}
