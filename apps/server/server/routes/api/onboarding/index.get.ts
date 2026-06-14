import type { OnboardingStatusResponse } from "@meridian/contracts/protocol";
import { defineEventHandler } from "nitro/h3";
import { requireAppUser } from "../../../lib/auth-gate.js";

export default defineEventHandler(async (event): Promise<OnboardingStatusResponse> => {
  const { app, user } = await requireAppUser(event);
  return app.onboarding.status(user.userId);
});
