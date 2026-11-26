import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { isMainCheckout, listCheckoutPaths } from "./checkout";

export type DevService = "app" | "server" | "www";
export type DevPorts = Record<DevService, number>;

const MAIN_CHECKOUT_BASE = 20_000;
const BLOCK_SIZE = 10;
const WORKTREE_BLOCKS = 799;

function parseBase(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const base = Number(raw);
  if (!Number.isInteger(base) || base < 1024 || base > 65_535 - BLOCK_SIZE) {
    throw new Error(`DEV_PORT_BASE must be a port between 1024 and 65525, got '${raw}'`);
  }
  return base;
}

function envLocalBase(checkout: string): string | undefined {
  try {
    return parseEnv(fs.readFileSync(path.join(checkout, ".env.local"), "utf8")).DEV_PORT_BASE;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

function pinWorktreePortBase(checkout: string): number {
  const taken = listCheckoutPaths(checkout).map((other) => Number(envLocalBase(other)));
  const blockBase = (block: number) => MAIN_CHECKOUT_BASE + BLOCK_SIZE * (1 + block);
  let block = createHash("sha256").update(checkout).digest().readUInt32BE(0) % WORKTREE_BLOCKS;
  while (taken.some((other) => Math.abs(other - blockBase(block)) < BLOCK_SIZE)) {
    block = (block + 1) % WORKTREE_BLOCKS;
  }
  const base = blockBase(block);
  const file = path.join(checkout, ".env.local");
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  fs.appendFileSync(
    file,
    `${existing === "" || existing.endsWith("\n") ? "" : "\n"}` +
      "# This worktree's dev ports: app, then server (+1) and www (+2). Chosen by `pnpm dev`; change it if something else holds them.\n" +
      `DEV_PORT_BASE=${base}\n`,
  );
  return base;
}

// keep: a checkout's ports have one source, DEV_PORT_BASE in its `.env.local`. A worktree without one is given a block here, written to that file, so no reader ever sees a guess; the main checkout defaults to 20000 and is never written to
export function resolveDevPorts(checkoutPath: string): DevPorts {
  const checkout = fs.realpathSync(checkoutPath);
  const base =
    parseBase(envLocalBase(checkout)) ??
    (isMainCheckout(checkout) ? MAIN_CHECKOUT_BASE : pinWorktreePortBase(checkout));
  return { app: base, server: base + 1, www: base + 2 };
}

export function browserUrl(port: number): string {
  return `http://localhost:${port}`;
}

// keep: processes talk over 127.0.0.1, where every service binds; `localhost` can resolve to ::1 first
export function loopbackOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}
