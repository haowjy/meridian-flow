import { sql } from "drizzle-orm";
import { bigint, customType, jsonb, timestamp, uuid } from "drizzle-orm/pg-core";

export const byteaColumn = customType<{ data: Buffer; driverData: string }>({
  dataType() {
    return "bytea";
  },
});

export const idColumn = <T extends string = string>() =>
  uuid("id").$type<T>().primaryKey().defaultRandom();

export const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const softDeleteAt = () => timestamp("deleted_at", { withTimezone: true });

export const jsonbDefault = (name: string) => jsonb(name).notNull().default(sql`'{}'::jsonb`);

export const millicredits = (name: string) => bigint(name, { mode: "number" });
