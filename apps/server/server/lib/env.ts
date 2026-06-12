import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(4000),
    DATABASE_URL: z.string().min(1).optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});

export const modelRequestDebugCaptureEnabled =
  process.env.MODEL_REQUEST_DEBUG_CAPTURE === "1" ||
  process.env.MODEL_REQUEST_DEBUG_CAPTURE === "true";
