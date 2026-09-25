/** GET /readyz: readiness probe verifying the app composes and the database answers, returning 503 otherwise. Depends on the app singleton and db. */

import { existsSync } from "node:fs";
import path from "node:path";
import { getSchemaStatus, type SchemaStatus } from "@meridian/database";
import { defineEventHandler, setResponseStatus } from "nitro/h3";
import { emitEvent, unknownToEventPayload } from "../domains/observability";
import { getApp } from "../lib/app";
import { getDb } from "../lib/db";
import { getProcessEventSink } from "../lib/observability";

let cachedReadySchemaStatus: "current" | "ahead" | undefined;
let pendingSchemaStatus: Promise<SchemaStatus> | undefined;

function releaseMigrationsDirectory(): string {
  const candidates = [
    path.resolve(process.cwd(), "release/migrations"),
    path.resolve(process.cwd(), "packages/database/src/migrations"),
    path.resolve(process.cwd(), "../../packages/database/src/migrations"),
  ];
  const directory = candidates.find((candidate) =>
    existsSync(path.join(candidate, "meta/_journal.json")),
  );
  if (!directory)
    throw new Error("The release migration journal is missing from the runtime bundle.");
  return directory;
}

async function checkSchemaStatus() {
  if (cachedReadySchemaStatus) return cachedReadySchemaStatus;
  if (!pendingSchemaStatus) {
    pendingSchemaStatus = getSchemaStatus({
      databaseUrl: process.env.DATABASE_URL ?? "",
      migrationsDirectory: releaseMigrationsDirectory(),
      async readAppliedHistory() {
        const client = getDb().$client;
        const [table] = await client<Array<{ exists: boolean }>>`
          SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS exists
        `;
        if (!table?.exists) return undefined;
        return client<Array<{ hash: string; created_at: string | number | null }>>`
          SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id ASC
        `;
      },
    });
  }
  const check = pendingSchemaStatus;
  try {
    const status = await check;
    if (status === "current" || status === "ahead") cachedReadySchemaStatus = status;
    return status;
  } finally {
    if (pendingSchemaStatus === check) pendingSchemaStatus = undefined;
  }
}

export default defineEventHandler(async (event) => {
  try {
    const schemaStatus = await checkSchemaStatus();
    if (schemaStatus === "behind" || schemaStatus === "divergent") {
      setResponseStatus(event, 503);
      return {
        status: "error",
        service: "api",
        ready: false,
        reason: schemaStatus === "behind" ? "schema_behind" : "schema_divergent",
      };
    }
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

  return { status: "ok", service: "api", ready: true };
});
