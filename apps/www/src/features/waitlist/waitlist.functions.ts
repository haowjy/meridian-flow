import { createServerFn } from "@tanstack/react-start";
import {
  parseWaitlistSubmissionInput,
  type WaitlistSubmissionInput,
  type WaitlistSubmissionSource,
} from "~/features/waitlist/waitlist.schema";

const WAITLIST_SUCCESS_REDIRECT_LOCATION = "/?waitlist=success";
const WAITLIST_ERROR_REDIRECT_LOCATION = "/?waitlist=error";
type WaitlistEmailSaver = (email: string) => Promise<void>;

function createWaitlistSubmissionResponse(
  source: WaitlistSubmissionSource,
): { ok: true } | Response {
  if (source === "form-data") {
    return new Response(null, {
      status: 303,
      headers: {
        Location: WAITLIST_SUCCESS_REDIRECT_LOCATION,
      },
    });
  }

  return { ok: true as const };
}

function createWaitlistSubmissionErrorResponse(source: WaitlistSubmissionSource): Response | null {
  if (source === "form-data") {
    return createWaitlistErrorRedirectResponse();
  }

  return null;
}

function createWaitlistErrorRedirectResponse(): Response {
  return new Response(null, {
    status: 303,
    headers: {
      Location: WAITLIST_ERROR_REDIRECT_LOCATION,
    },
  });
}

async function handleParsedWaitlistSubmission(
  input: WaitlistSubmissionInput,
  saveWaitlistEmail: WaitlistEmailSaver,
): Promise<{ ok: true } | Response> {
  try {
    await saveWaitlistEmail(input.submission.email);
    return createWaitlistSubmissionResponse(input.source);
  } catch (error) {
    const response = createWaitlistSubmissionErrorResponse(input.source);
    if (response) {
      return response;
    }

    throw error;
  }
}

export async function handleWaitlistSubmission(
  rawInput: unknown,
  saveWaitlistEmail: WaitlistEmailSaver,
): Promise<{ ok: true } | Response> {
  const isFormDataSubmission = rawInput instanceof FormData;

  try {
    const parsedInput = parseWaitlistSubmissionInput(rawInput);
    return await handleParsedWaitlistSubmission(parsedInput, saveWaitlistEmail);
  } catch (error) {
    if (isFormDataSubmission) {
      return createWaitlistErrorRedirectResponse();
    }

    throw error;
  }
}

export const submitWaitlistEmail = createServerFn({ method: "POST" })
  .inputValidator((data) => data)
  .handler(async ({ data }) => {
    const { saveWaitlistEmail } = await import("~/features/waitlist/waitlist.server");
    return handleWaitlistSubmission(data, saveWaitlistEmail);
  });
