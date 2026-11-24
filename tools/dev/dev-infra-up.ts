#!/usr/bin/env bun
import { resolveCurrentRepoRoot } from "./lib/dev-env";
import { ensureDevInfraUp } from "./lib/dev-infra";

ensureDevInfraUp(resolveCurrentRepoRoot());
