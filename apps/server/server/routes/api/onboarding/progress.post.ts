import type {
  OnboardingProgressRequest,
  OnboardingProgressResponse,
} from "@meridian/contracts/protocol";
import { createError, defineEventHandler, readBody, setResponseStatus } from "nitro/h3";
import { requireAppUser } from "../../../lib/auth-gate.js";

export default defineEventHandler(async (event): Promise<OnboardingProgressResponse> => {
  const { app, user } = await requireAppUser(event);
  const body = (await readBody<OnboardingProgressRequest>(event)) ?? null;
  if (
    !body ||
    typeof body.stepId !== "string" ||
    !body.answers ||
    typeof body.answers !== "object"
  ) {
    throw createError({ statusCode: 400, message: "stepId and answers are required" });
  }
  const result = await app.onboarding.saveProgress(user.userId, body);
  setResponseStatus(event, 200);
  return result;
});
