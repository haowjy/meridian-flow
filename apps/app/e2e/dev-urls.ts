import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { browserUrl } from "../../../tools/dev/lib/dev-ports";
import { stackPorts } from "../../../tools/dev/lib/dev-stack";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export function resolveAppUrl(): string {
  return process.env.APP_URL?.trim() || browserUrl(stackPorts(REPO_ROOT).app);
}

export function resolveServerUrl(): string {
  return process.env.SERVER_URL?.trim() || browserUrl(stackPorts(REPO_ROOT).server);
}
