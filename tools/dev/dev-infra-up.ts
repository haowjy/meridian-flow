#!/usr/bin/env tsx
/** `pnpm dev:infra`: start the shared dev Postgres unless it is already running and healthy. */
import { resolveCurrentRepoRoot } from "./lib/dev-env";
import { ensureDevInfraUp } from "./lib/dev-infra";

ensureDevInfraUp(resolveCurrentRepoRoot());
