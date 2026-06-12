import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

// WEB_DATABASE_URL must already be present in the environment — supplied by direnv
// (worktree-rewritten via tools/dev), by `prepare-db`, or by the deploy platform.
// We do NOT walk .env files here: in a linked worktree that would resolve the
// un-rewritten base name and silently point at the shared marketing database.

export const env = createEnv({
  server: {
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    WEB_DATABASE_URL: z.string().min(1),
  },
  runtimeEnv: process.env,
});
