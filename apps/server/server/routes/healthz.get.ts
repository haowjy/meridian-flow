/** GET /healthz: liveness probe returning a static ok status. No dependencies. */
import { defineEventHandler } from "nitro/h3";

export default defineEventHandler(() => {
  return { status: "ok", service: "api" };
});
