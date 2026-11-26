import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

export type DevService = "app" | "server" | "www";
export type DevPorts = Record<DevService, number>;

const MAIN_CHECKOUT_BASE = 20_000;
const BLOCK_SIZE = 10;
const WORKTREE_BLOCKS = 799;

function overrideBase(checkout: string, env: NodeJS.ProcessEnv): number | undefined {
  let raw = env.DEV_PORT_BASE;
  if (raw === undefined) {
    try {
      raw = parseEnv(fs.readFileSync(path.join(checkout, ".env.local"), "utf8")).DEV_PORT_BASE;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (raw === undefined || raw === "") return undefined;
  const base = Number(raw);
  if (!Number.isInteger(base) || base < 1024 || base > 65_535 - BLOCK_SIZE) {
    throw new Error(`DEV_PORT_BASE must be a port between 1024 and 65525, got '${raw}'`);
  }
  return base;
}

export function resolveDevPorts(
  checkoutPath: string,
  env: NodeJS.ProcessEnv = process.env,
): DevPorts {
  const checkout = fs.realpathSync(checkoutPath);
  // A linked worktree's `.git` is a file; only the main checkout has the directory.
  const isMain =
    fs.statSync(path.join(checkout, ".git"), { throwIfNoEntry: false })?.isDirectory() ?? true;
  const hashed = createHash("sha256").update(checkout).digest().readUInt32BE(0) % WORKTREE_BLOCKS;
  const base =
    overrideBase(checkout, env) ??
    (isMain ? MAIN_CHECKOUT_BASE : MAIN_CHECKOUT_BASE + BLOCK_SIZE * (1 + hashed));
  return { app: base, server: base + 1, www: base + 2 };
}

export function browserUrl(port: number): string {
  return `http://localhost:${port}`;
}

// keep: processes talk over 127.0.0.1, where every service binds; `localhost` can resolve to ::1 first
export function loopbackOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}
