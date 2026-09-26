/** Command spec, strict flat-arg parsing, and shared resolvers (thread ids, projects, Works, durations). */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  API_THREADS_PATH,
  apiProjectWorksPath,
  type ListThreadsResponse,
  type ListWorksResponse,
} from "@meridian/contracts/protocol";
import { CliError, type ExitCode, usageError } from "./cli-error";
import type { Output } from "./output";
import type { Session } from "./session";

export type OptionSpec = {
  type: "string" | "boolean";
  multiple?: boolean;
  short?: string;
  description: string;
};

export type OptionValues = Record<string, string | boolean | string[] | undefined>;

export interface CommandContext {
  positionals: string[];
  values: OptionValues;
  out: Output;
  session(): Promise<Session>;
  env: NodeJS.ProcessEnv;
}

export interface CommandSpec {
  /** Noun-verb path, e.g. ["thread", "view"]. */
  path: string[];
  summary: string;
  /** Positional synopsis, e.g. "<thread>". */
  args?: string;
  /** The API route(s) this command wraps; printed by help so the mapping stays obvious. */
  route: string;
  options?: Record<string, OptionSpec>;
  examples: string[];
  run(ctx: CommandContext): Promise<ExitCode | undefined>;
}

export const GLOBAL_OPTIONS: Record<string, OptionSpec> = {
  json: { type: "boolean", description: "JSON output (one object; NDJSON for streams)" },
  fields: { type: "string", description: "Comma-separated top-level JSON fields to keep" },
  help: { type: "boolean", short: "h", description: "Show help for this command" },
};

export function parseCommandArgs(
  spec: CommandSpec,
  argv: string[],
): { positionals: string[]; values: OptionValues } {
  const options = { ...GLOBAL_OPTIONS, ...spec.options };
  try {
    const parsed = parseArgs({
      args: argv,
      options: Object.fromEntries(
        Object.entries(options).map(([name, option]) => [
          name,
          {
            type: option.type,
            ...(option.multiple ? { multiple: true } : {}),
            ...(option.short ? { short: option.short } : {}),
          },
        ]),
      ),
      allowPositionals: true,
      strict: true,
    });
    return { positionals: parsed.positionals, values: parsed.values as OptionValues };
  } catch (error) {
    throw usageError(
      error instanceof Error ? error.message : String(error),
      `Run \`./mf ${spec.path.join(" ")} --help\`.`,
    );
  }
}

export function requirePositional(ctx: CommandContext, index: number, name: string): string {
  const value = ctx.positionals[index];
  if (!value) throw usageError(`Missing ${name}`);
  return value;
}

export function stringOption(ctx: CommandContext, name: string): string | undefined {
  const value = ctx.values[name];
  return typeof value === "string" ? value : undefined;
}

export function listOption(ctx: CommandContext, name: string): string[] {
  const value = ctx.values[name];
  return Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
}

export function flag(ctx: CommandContext, name: string): boolean {
  return ctx.values[name] === true;
}

export function intOption(ctx: CommandContext, name: string, fallback: number): number {
  const raw = stringOption(ctx, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0)
    throw usageError(`--${name} must be a non-negative integer`);
  return value;
}

/** `90s`, `5m`, `1500ms`, or bare seconds. */
export function parseDuration(raw: string, name: string): number {
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!match) throw usageError(`${name} must look like 30s, 5m, or 1500ms`);
  const amount = Number(match[1]);
  const unit = match[2] ?? "s";
  const factor = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
  return Math.round(amount * factor);
}

export function durationOption(ctx: CommandContext, name: string, fallbackMs: number): number {
  const raw = stringOption(ctx, name);
  return raw === undefined ? fallbackMs : parseDuration(raw, `--${name}`);
}

/** `@path` reads a file, `-` reads stdin, anything else is literal. */
export function readValueArg(raw: string): string {
  if (raw === "-") return readFileSync(0, "utf8");
  if (raw.startsWith("@")) {
    try {
      return readFileSync(raw.slice(1), "utf8");
    } catch (error) {
      throw usageError(`Cannot read ${raw.slice(1)}: ${(error as Error).message}`);
    }
  }
  return raw;
}

export function readJsonArg(raw: string, name: string): unknown {
  const text = readValueArg(raw);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw usageError(`${name} is not valid JSON: ${(error as Error).message}`);
  }
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Accepts a full id, an app URL containing one, a unique id prefix, or a `cN`/`pN` ref. */
export async function resolveThreadId(session: Session, raw: string): Promise<string> {
  const embedded = raw.match(UUID)?.[0];
  if (embedded) return embedded.toLowerCase();
  const { threads } = await session.request<ListThreadsResponse>("GET", API_THREADS_PATH);
  const matches = threads.filter((thread) => thread.id.startsWith(raw) || thread.ref === raw);
  if (matches.length === 1) return (matches[0] as { id: string }).id;
  if (matches.length === 0) {
    throw new CliError("not_found", `No thread matches "${raw}"`, {
      hint: "Run `./mf thread list` to see thread ids.",
    });
  }
  throw new CliError("usage", `"${raw}" matches ${matches.length} threads`, {
    details: matches
      .slice(0, 10)
      .map((thread) => ({ id: thread.id, ref: thread.ref, title: thread.title })),
    hint: "Use a longer prefix or the full id.",
  });
}

type BootstrapResult = { projectId: string };

/** `--project <id>`; omitted or `default` ensures and returns the writer's default project. */
export async function resolveProjectId(session: Session, raw: string | undefined): Promise<string> {
  if (raw && raw !== "default") return raw;
  const bootstrap = await session.request<BootstrapResult>(
    "POST",
    "/api/projects/bootstrap-default",
  );
  return bootstrap.projectId;
}

/** `@/` (or omitted) → No Work (null); `@slug` → that Work's id; a bare id passes through. */
export async function resolveWorkId(
  session: Session,
  projectId: string,
  raw: string | undefined,
): Promise<string | null> {
  if (raw === undefined || raw === "@/" || raw === "@") return null;
  if (!raw.startsWith("@")) return raw;
  const slug = raw.slice(1);
  const snapshot = await session.request<ListWorksResponse>("GET", apiProjectWorksPath(projectId));
  const work = snapshot.works.find((entry) => entry.slug === slug);
  if (!work) {
    throw new CliError("not_found", `No Work with slug @${slug} in project ${projectId}`, {
      details: snapshot.works.map((entry) => `@${entry.slug}`),
    });
  }
  return work.id;
}
