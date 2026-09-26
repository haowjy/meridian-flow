/**
 * `./mf` entry: local dev CLI that wraps this worktree's app API for agents and humans.
 * Commands are noun-verb, output is compact text or --json, and exit codes are the contract.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CliError, EXIT, type ExitCode } from "./cli-error";
import { type CommandSpec, GLOBAL_OPTIONS, parseCommandArgs } from "./command";
import { apiCommand } from "./commands/api";
import { docPutCommand, docReadCommand, docRmCommand } from "./commands/doc";
import { logCommand } from "./commands/log";
import { mockClearCommand, mockListCommand, mockScriptCommand } from "./commands/mock";
import { projectDefaultCommand, projectListCommand } from "./commands/project";
import { seedCommand } from "./commands/seed";
import {
  threadCancelCommand,
  threadCreateCommand,
  threadRespondCommand,
  threadSendCommand,
  threadTailCommand,
} from "./commands/thread-drive";
import {
  threadContextCommand,
  threadEventsCommand,
  threadListCommand,
  threadViewCommand,
} from "./commands/thread-read";
import { type Io, Output } from "./output";
import { openSession, type Session } from "./session";

export const COMMANDS: readonly CommandSpec[] = [
  threadListCommand,
  threadViewCommand,
  threadContextCommand,
  threadEventsCommand,
  threadCreateCommand,
  threadSendCommand,
  threadTailCommand,
  threadCancelCommand,
  threadRespondCommand,
  logCommand,
  projectListCommand,
  projectDefaultCommand,
  docReadCommand,
  docPutCommand,
  docRmCommand,
  seedCommand,
  mockScriptCommand,
  mockListCommand,
  mockClearCommand,
  apiCommand,
];

const EXIT_CODE_LINES = [
  "0 ok (empty results included)",
  "1 run failed or server error",
  "2 usage",
  "3 not found",
  "4 stack not running or dev login failed",
  "5 cancelled",
  "8 waiting on an interrupt (./mf thread respond)",
  "124 timeout",
];

function synopsis(spec: CommandSpec): string {
  return `./mf ${spec.path.join(" ")}${spec.args ? ` ${spec.args}` : ""}`;
}

export function renderOverview(commands: readonly CommandSpec[]): string {
  const width = Math.max(...commands.map((spec) => synopsis(spec).length));
  return [
    "mf: drive and inspect this worktree's running Meridian Flow stack through its own API.",
    "Needs `pnpm dev` running (or MF_SERVER_URL + MF_COOKIE/MF_APP_URL).",
    "",
    ...commands.map(
      (spec) =>
        `  ${synopsis(spec).padEnd(width)}  ${spec.summary}\n  ${"".padEnd(width)}  ↳ ${spec.route}`,
    ),
    "",
    "Global: --json (one object; NDJSON for streams, last line is the result), --fields a,b, -h/--help",
    `Exit codes: ${EXIT_CODE_LINES.join("; ")}`,
    "",
    'Start: ./mf seed tools/dev/cli/fixtures/basic.json  |  ./mf thread send <id> "hi"  |  ./mf thread view <id>',
  ].join("\n");
}

export function renderCommandHelp(spec: CommandSpec): string {
  const options = { ...spec.options, ...GLOBAL_OPTIONS };
  const width = Math.max(...Object.keys(options).map((name) => name.length + 4));
  return [
    `Usage: ${synopsis(spec)} [options]`,
    "",
    spec.summary,
    `Wraps: ${spec.route}`,
    "",
    "Options:",
    ...Object.entries(options).map(
      ([name, option]) =>
        `  --${name}${option.type === "string" ? " <v>" : ""}`.padEnd(width + 6) +
        `${option.short ? `(-${option.short}) ` : ""}${option.description}${option.multiple ? " (repeatable)" : ""}`,
    ),
    "",
    "Examples:",
    ...spec.examples.map((example) => `  ${example}`),
  ].join("\n");
}

function findCommand(argv: string[]): { spec: CommandSpec; rest: string[] } | null {
  let best: CommandSpec | null = null;
  for (const spec of COMMANDS) {
    if (spec.path.every((part, index) => argv[index] === part)) {
      if (!best || spec.path.length > best.path.length) best = spec;
    }
  }
  return best ? { spec: best, rest: argv.slice(best.path.length) } : null;
}

export type RunDeps = {
  io: Io;
  env: NodeJS.ProcessEnv;
  repoRoot: string;
  openSession?: (input: { repoRoot: string; env: NodeJS.ProcessEnv }) => Promise<Session>;
};

export async function runCli(argv: string[], deps: RunDeps): Promise<ExitCode> {
  const wantsJson = argv.includes("--json");
  const bootstrapOut = new Output(deps.io, { json: wantsJson });
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    deps.io.stdout.write(`${renderOverview(COMMANDS)}\n`);
    return EXIT.ok;
  }
  const found = findCommand(argv);
  if (!found) {
    const noun = COMMANDS.filter((spec) => spec.path[0] === argv[0]);
    if (noun.length > 0 && (argv.length === 1 || argv[1]?.startsWith("-"))) {
      deps.io.stdout.write(`${renderOverview(noun)}\n`);
      return EXIT.ok;
    }
    bootstrapOut.error(
      new CliError("usage", `Unknown command: ${argv.slice(0, 2).join(" ")}`, {
        hint: "Run `./mf` for the command list.",
      }),
    );
    return EXIT.usage;
  }

  let out = bootstrapOut;
  try {
    const { positionals, values } = parseCommandArgs(found.spec, found.rest);
    if (values.help === true) {
      deps.io.stdout.write(`${renderCommandHelp(found.spec)}\n`);
      return EXIT.ok;
    }
    const fieldsRaw = typeof values.fields === "string" ? values.fields : undefined;
    out = new Output(deps.io, {
      json: values.json === true,
      ...(fieldsRaw
        ? {
            fields: fieldsRaw
              .split(",")
              .map((field) => field.trim())
              .filter(Boolean),
          }
        : {}),
    });
    let session: Promise<Session> | null = null;
    const ctx = {
      positionals,
      values,
      out,
      env: deps.env,
      session: () => {
        session ??= (deps.openSession ?? openSession)({ repoRoot: deps.repoRoot, env: deps.env });
        return session;
      },
    };
    return (await found.spec.run(ctx)) ?? EXIT.ok;
  } catch (error) {
    const cliError =
      error instanceof CliError
        ? error
        : new CliError("http_error", error instanceof Error ? error.message : String(error));
    out.error(cliError);
    return cliError.exitCode;
  }
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function main(): Promise<void> {
  // exitCode, never process.exit(): exiting early truncates piped stdout.
  process.exitCode = await runCli(process.argv.slice(2), {
    io: { stdout: process.stdout, stderr: process.stderr },
    env: process.env,
    repoRoot: REPO_ROOT,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
