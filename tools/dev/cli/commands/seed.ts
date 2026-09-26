/** `./mf seed`: one-shot scenario setup (docs, a thread, opening messages) from a JSON fixture. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { EXIT, type ExitCode, usageError } from "../cli-error";
import {
  type CommandSpec,
  flag,
  parseDuration,
  requirePositional,
  resolveProjectId,
} from "../command";
import { putDocument } from "./doc";
import { createThread, exitForOutcome, type SendOutcome, sendMessage } from "./thread-drive";

export type SeedFixture = {
  project?: string;
  overwrite?: boolean;
  docs?: { uri: string; text?: string; file?: string; work?: string }[];
  thread?: { agent?: string; work?: string; title?: string };
  messages?: {
    text: string;
    refs?: string[];
    skills?: string[];
    mock?: unknown;
    timeout?: string;
  }[];
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** Structural validation with precise paths; unknown keys are rejected so typos fail loudly. */
export function parseSeedFixture(raw: unknown): SeedFixture {
  const fail = (message: string): never => {
    throw usageError(`Invalid seed fixture: ${message}`);
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("expected an object");
  const fixture = raw as Record<string, unknown>;
  for (const key of Object.keys(fixture)) {
    if (!["project", "overwrite", "docs", "thread", "messages"].includes(key))
      fail(`unknown key "${key}"`);
  }
  if (fixture.project !== undefined && typeof fixture.project !== "string")
    fail("project must be a string");
  if (fixture.docs !== undefined) {
    if (!Array.isArray(fixture.docs)) fail("docs must be an array");
    (fixture.docs as unknown[]).forEach((doc, index) => {
      const entry = doc as Record<string, unknown>;
      if (typeof entry?.uri !== "string") fail(`docs[${index}].uri must be a string`);
      if ((entry.text === undefined) === (entry.file === undefined)) {
        fail(`docs[${index}] needs exactly one of text or file`);
      }
    });
  }
  if (fixture.messages !== undefined) {
    if (!Array.isArray(fixture.messages)) fail("messages must be an array");
    (fixture.messages as unknown[]).forEach((message, index) => {
      const entry = message as Record<string, unknown>;
      if (typeof entry?.text !== "string" || !entry.text)
        fail(`messages[${index}].text is required`);
      if (entry.refs !== undefined && !isStringArray(entry.refs))
        fail(`messages[${index}].refs must be strings`);
      if (entry.skills !== undefined && !isStringArray(entry.skills)) {
        fail(`messages[${index}].skills must be strings`);
      }
    });
    if (fixture.thread === undefined) fail("messages need a thread");
  }
  return fixture as SeedFixture;
}

export const seedCommand: CommandSpec = {
  path: ["seed"],
  summary: "Set up a scenario from a fixture: docs, a thread, opening messages",
  args: "<fixture.json>",
  route: "composes doc put + POST /api/threads + thread send",
  options: {
    overwrite: { type: "boolean", description: "Replace docs that already exist" },
  },
  examples: [
    "./mf seed tools/dev/cli/fixtures/basic.json",
    "./mf seed tools/dev/cli/fixtures/basic.json --json | jq -r .threadId",
  ],
  async run(ctx) {
    const fixturePath = requirePositional(ctx, 0, "<fixture.json>");
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(fixturePath, "utf8"));
    } catch (error) {
      throw usageError(`Cannot read fixture ${fixturePath}: ${(error as Error).message}`);
    }
    const fixture = parseSeedFixture(raw);
    const baseDir = path.dirname(path.resolve(fixturePath));
    const overwrite = flag(ctx, "overwrite") || fixture.overwrite === true;
    const session = await ctx.session();
    const projectId = await resolveProjectId(session, fixture.project);

    const docs = [];
    for (const doc of fixture.docs ?? []) {
      const content = doc.file
        ? readFileSync(path.resolve(baseDir, doc.file), "utf8")
        : (doc.text ?? "");
      const result = await putDocument(session, {
        projectId,
        uri: doc.uri,
        content,
        work: doc.work,
        overwrite,
      });
      ctx.out.note(`${result.replaced ? "replaced" : "created"} ${result.uri}`);
      docs.push(result);
    }

    let threadId: string | null = null;
    const messages: SendOutcome[] = [];
    let exitCode: ExitCode = EXIT.ok;
    if (fixture.thread) {
      threadId = (await createThread(session, { project: projectId, ...fixture.thread })).id;
      ctx.out.note(`created thread ${threadId}`);
      const progress = ctx.out.progressOnly();
      for (const message of fixture.messages ?? []) {
        const outcome = await sendMessage(session, progress, {
          threadId,
          text: message.text,
          refs: message.refs,
          skills: message.skills,
          ...(message.mock !== undefined ? { mock: message.mock } : {}),
          timeoutMs: message.timeout ? parseDuration(message.timeout, "timeout") : 5 * 60_000,
          full: false,
        });
        messages.push(outcome);
        exitCode = exitForOutcome(outcome);
        if (exitCode !== EXIT.ok) break;
      }
    }

    ctx.out.result({ projectId, docs, threadId, messages }, (value) =>
      [
        `project ${value.projectId}`,
        ...value.docs.map((doc) => `doc ${doc.uri} ${doc.documentId}`),
        ...(value.threadId ? [`thread ${value.threadId}`] : []),
        ...value.messages.map(
          (message) =>
            `message turn ${message.turnId ?? "?"} ${message.status}${message.error ? `: ${message.error}` : ""}`,
        ),
      ].join("\n"),
    );
    return exitCode;
  },
};
