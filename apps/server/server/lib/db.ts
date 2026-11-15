import { createDb, type Database } from "@meridian/database";
import postgres, { type Sql } from "postgres";

import { env } from "./env.js";

let dbClient: Database | undefined;

export function getDb(): Database {
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required once server domains start using the database.");
  }
  if (!dbClient) {
    dbClient = createDb(env.DATABASE_URL);
  }
  return dbClient;
}

let levelLockClient: Sql | undefined;

/** The small client the Agents level locks wait on, apart from `getDb()`'s pool (see `agents-level-lock.ts`). */
export function getLevelLockClient(): Sql {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required for the Agents level locks.");
  levelLockClient ??= postgres(env.DATABASE_URL, { max: 8 });
  return levelLockClient;
}
