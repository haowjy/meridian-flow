#!/usr/bin/env tsx
import { resolve } from "node:path";
import { loadRepoEnv, requireEnv } from "./load-env.ts";
import { seedDevProject } from "./seed-dev-project.ts";
import { seedDevUser } from "./seed-dev-user.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
loadRepoEnv(repoRoot);

async function main(): Promise<void> {
  const databaseUrl = requireEnv("DATABASE_URL");
  const externalId = requireEnv("WORKOS_DEV_LOGIN_USER_ID");
  const email = process.env.WORKOS_DEV_LOGIN_EMAIL?.trim() || "test@meridian.dev";

  const userId = await seedDevUser({ databaseUrl, externalId, email });
  const projectId = await seedDevProject(databaseUrl, userId);
  if (!projectId) {
    throw new Error("seed did not return a project id");
  }
  console.log(`seed: dev user ready (${userId}), sample project ready (${projectId})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
