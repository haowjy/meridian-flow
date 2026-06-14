import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

const webDatabaseUrl = process.env.WEB_DATABASE_URL ?? process.env.DATABASE_URL;

export const env = createEnv({
  server: {
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    WEB_DATABASE_URL: z.string().min(1),
  },
  runtimeEnv: { ...process.env, WEB_DATABASE_URL: webDatabaseUrl },
});
