import { createDb, type Database } from "@meridian/database";

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

let dbClosed = false;

export async function closeDb(): Promise<void> {
  if (!dbClient || dbClosed) return;
  dbClosed = true;
  await dbClient.close();
}
