import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { browserUrl, resolveDevPorts } from "../../../tools/dev/lib/dev-ports";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export function resolveAppUrl(): string {
  return process.env.APP_URL?.trim() || browserUrl(resolveDevPorts(REPO_ROOT).app);
}

export function resolveServerUrl(): string {
  return process.env.SERVER_URL?.trim() || browserUrl(resolveDevPorts(REPO_ROOT).server);
}
