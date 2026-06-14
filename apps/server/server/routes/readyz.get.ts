/** GET /readyz: readiness probe verifying the app composes and the database answers, returning 503 otherwise. Depends on the app singleton and db. */
import { sql } from "drizzle-orm";
import { defineEventHandler, setResponseStatus } from "nitro/h3";

import { getApp } from "../lib/app";
import { getDb } from "../lib/db";

function reasonFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default defineEventHandler(async (event) => {
  try {
    await getApp();
  } catch (error) {
    setResponseStatus(event, 503);
    return {
      status: "error",
      service: "api",
      ready: false,
      reason: `app_init_failed: ${reasonFromError(error)}`,
    };
  }

  try {
    await getDb().execute(sql`SELECT 1`);
  } catch (error) {
    setResponseStatus(event, 503);
    return {
      status: "error",
      service: "api",
      ready: false,
      reason: `database_unavailable: ${reasonFromError(error)}`,
    };
  }

  return { status: "ok", service: "api", ready: true };
});
