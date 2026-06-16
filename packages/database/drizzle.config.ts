import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for drizzle-kit");
}

export default defineConfig({
  schema: "./src/schema/drizzle.ts",
  out: "./src/migrations",
  dialect: "postgresql",
  dbCredentials: { url: databaseUrl },
  // Only generate migrations for public app tables (identity is app-owned public.users).
  schemaFilter: ["public"],
});
