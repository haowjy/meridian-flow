#!/usr/bin/env tsx
import { resolve } from "node:path";
import { loadRepoEnv, requireEnv } from "./load-env.ts";
import { seedDevProject } from "./seed-dev-project.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
loadRepoEnv(repoRoot);

async function main(): Promise<void> {
  const databaseUrl = requireEnv("DATABASE_URL");
  const userId = requireEnv("TEST_USER_ID");
  const projectId = await seedDevProject(databaseUrl, userId);
  if (!projectId) {
    throw new Error("seed did not return a project id");
  }
  console.log(`seed: sample project ready (${projectId})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
