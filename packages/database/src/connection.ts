import { drizzle } from "drizzle-orm/postgres-js";
import type { Options } from "postgres";
import postgres from "postgres";
import { schema } from "./schema/index";

export type Database = ReturnType<typeof createDb>;

export type CreateDbOptions = {
  max?: number;
  postgres?: Options<Record<string, never>>;
};

export function createDb(databaseUrl: string, options?: CreateDbOptions) {
  const client = postgres(databaseUrl, {
    max: options?.max ?? 1,
    ...options?.postgres,
  });
  const db = drizzle(client, { schema });
  return Object.assign(db, {
    close: () => client.end(),
  });
}
