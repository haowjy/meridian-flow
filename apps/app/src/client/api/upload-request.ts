/** The two server calls around a direct upload (start and finish), and their errors in the writer's words. */
import { t } from "@lingui/core/macro";

import { UploadRefusedError } from "./direct-upload";
import { errorMessageFromPayload, readResponsePayload } from "./http-client";
import { meridianApiErrorFromPayload } from "./meridian-error";

export const jsonPost = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** `tooLarge` is the message for a file over the limit, which each destination words for itself. */
export async function uploadResponse<T>(
  request: Promise<Response>,
  tooLarge: () => string,
): Promise<T> {
  const value = await request.catch((cause: unknown) => {
    // `fetch` rejects with a bare TypeError ("Failed to fetch") when the network is down.
    throw cause instanceof TypeError
      ? new Error(t`Couldn't reach the server. Check your connection.`, { cause })
      : cause;
  });
  const payload = await readResponsePayload(value);
  if (!value.ok) {
    const message =
      typeof payload === "object" && payload && "message" in payload ? payload.message : null;
    if (message === "invalid_filename")
      throw new UploadRefusedError(
        t`This filename contains unsupported characters. Rename the file and try again.`,
      );
    if (message === "too_large") throw new UploadRefusedError(tooLarge());
    throw (
      meridianApiErrorFromPayload(payload, value.status) ??
      new Error(errorMessageFromPayload(payload, value.status))
    );
  }
  return payload as T;
}
