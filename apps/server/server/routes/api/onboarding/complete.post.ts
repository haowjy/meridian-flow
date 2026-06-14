import type {
  OnboardingCompleteRequest,
  OnboardingCompleteResponse,
} from "@meridian/contracts/protocol";
import { createError, defineEventHandler, readBody, setResponseStatus } from "nitro/h3";
import { requireAppUser } from "../../../lib/auth-gate.js";

export default defineEventHandler(async (event): Promise<OnboardingCompleteResponse> => {
  const { app, user } = await requireAppUser(event);
  const body = (await readBody<OnboardingCompleteRequest>(event)) ?? null;
  if (!body || (body.path !== "import_corpus" && body.path !== "start_chatting")) {
    throw createError({ statusCode: 400, message: "path is required" });
  }
  const result = await app.onboarding.complete(user.userId, body);
  if (!result.state.documentId) {
    throw createError({ statusCode: 500, message: "onboarding document was not created" });
  }
  await app.documentSync.initializeMirror(result.state.documentId);
  setResponseStatus(event, 200);
  return result;
});
