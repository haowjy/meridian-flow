import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "~/server/db/schema";
import { env } from "~/server/env";

let dbClient: ReturnType<typeof drizzle> | null = null;

function createDbClient() {
  const sql = postgres(env.WEB_DATABASE_URL, { prepare: false });
  return drizzle(sql, { schema });
}

export function getDb() {
  if (!dbClient) {
    dbClient = createDbClient();
  }

  return dbClient;
}
