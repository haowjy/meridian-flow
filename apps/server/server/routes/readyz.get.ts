/** GET /readyz: readiness probe verifying the app composes and the database answers, returning 503 otherwise. Depends on the app singleton and db. */
import { sql } from "drizzle-orm";
import { defineEventHandler, setResponseStatus } from "nitro/h3";
import { emitEvent, unknownToEventPayload } from "../domains/observability";
import { getApp } from "../lib/app";
import { getDb } from "../lib/db";
import { getProcessEventSink } from "../lib/observability";

export default defineEventHandler(async (event) => {
  try {
    await getApp();
  } catch (error) {
    emitEvent(getProcessEventSink(), {
      level: "error",
      source: "routes.readyz",
      name: "app_init_failed",
      payload: unknownToEventPayload(error),
    });
    setResponseStatus(event, 503);
    return {
      status: "error",
      service: "api",
      ready: false,
      reason: "app_init_failed",
    };
  }

  try {
    await getDb().execute(sql`SELECT 1`);
  } catch (error) {
    emitEvent(getProcessEventSink(), {
      level: "error",
      source: "routes.readyz",
      name: "database_unavailable",
      payload: unknownToEventPayload(error),
    });
    setResponseStatus(event, 503);
    return {
      status: "error",
      service: "api",
      ready: false,
      reason: "database_unavailable",
    };
  }

  return { status: "ok", service: "api", ready: true };
});
