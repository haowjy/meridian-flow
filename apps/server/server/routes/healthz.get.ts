/** GET /healthz: liveness probe returning a static ok status and release identity. No dependencies. */
import { defineEventHandler } from "nitro/h3";

export default defineEventHandler(() => {
  return { status: "ok", service: "api", release: process.env.MERIDIAN_RELEASE_SHA ?? "unknown" };
});
