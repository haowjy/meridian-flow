/**
 * The model-edit crash harness: a scratch database seeded by the parent, a composed server in a
 * child process the parent can kill at a named test hook point, and a second child that recovers.
 * The probes in `../model-edit-*` drive it; each asserts on rows, never on the child's memory.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createScratchDatabase, openHarness } from "../drafts-lock-free/harness.mts";

export { createScratchDatabase, openHarness };

const CHILD_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "child.mts");

let bundled: Promise<string> | undefined;

/**
 * The child as one bundled file. Starting it through tsx transpiles the server's whole import
 * graph on each boot (about 8 s); the bundle starts in about 1 s, which is what lets a probe
 * kill a process per case. The workspace's own source is inlined, other packages stay external.
 */
function childBundle(): Promise<string> {
  bundled ??= (async () => {
    const outfile = join(tmpdir(), `model-edit-child-${process.pid}.mjs`);
    process.once("exit", () => rmSync(outfile, { force: true }));
    await build({
      entryPoints: [CHILD_SOURCE],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      logLevel: "warning",
      plugins: [
        {
          name: "external-packages",
          setup(b) {
            b.onResolve({ filter: /^[^./]/ }, async (args) => {
              if (args.path.startsWith("#")) return { path: args.path, external: true };
              if (/^@meridian(-flow)?\//.test(args.path) || args.pluginData === "inner")
                return null;
              const found = await b.resolve(args.path, {
                resolveDir: args.resolveDir,
                kind: args.kind,
                pluginData: "inner",
              });
              return found.errors.length ? null : { path: found.path, external: true };
            });
          },
        },
      ],
    });
    return outfile;
  })();
  return bundled;
}

export type Message = {
  event?: string;
  id?: number;
  ok?: boolean;
  point?: string;
  [k: string]: unknown;
};

/** A composed server process. `exited` resolves with its signal or exit code. */
export class Child {
  readonly exited: Promise<string>;
  private readonly lines: Message[] = [];
  private readonly waiters: (() => void)[] = [];
  private nextId = 1;
  private readonly proc: ChildProcess;

  private constructor(url: string, bundle: string) {
    this.proc = spawn(process.execPath, [bundle], {
      env: { ...process.env, DATABASE_URL: url },
      stdio: ["pipe", "pipe", "inherit"],
    });
    createInterface({ input: this.proc.stdout as NodeJS.ReadableStream }).on("line", (line) => {
      try {
        this.lines.push(JSON.parse(line));
        for (const wake of this.waiters.splice(0)) wake();
      } catch {
        process.stderr.write(`child: ${line}\n`);
      }
    });
    this.exited = new Promise((done) =>
      this.proc.once("exit", (code, signal) => done(signal ?? `exit ${code}`)),
    );
  }

  static async start(url: string): Promise<Child> {
    const child = new Child(url, await childBundle());
    await child.waitFor((m) => m.event === "ready", 60_000);
    return child;
  }

  /** The first message matching `match` not yet taken; waits for it. */
  async waitFor(match: (m: Message) => boolean, timeoutMs = 30_000): Promise<Message> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const at = this.lines.findIndex(match);
      if (at >= 0) return this.lines.splice(at, 1)[0] as Message;
      if (Date.now() > until) throw new Error("timed out waiting for the child");
      await new Promise<void>((wake) => {
        this.waiters.push(wake);
        setTimeout(wake, 100);
      });
    }
  }

  /** Sends an op without waiting for it to settle; returns its id. */
  post(op: Record<string, unknown>): number {
    const id = this.nextId++;
    this.proc.stdin?.write(`${JSON.stringify({ ...op, id })}\n`);
    return id;
  }

  async call(op: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    const id = this.post(op);
    const answer = await this.waitFor((m) => m.id === id, timeoutMs);
    if (!answer.ok) throw new Error(String(answer.error));
    return answer.result;
  }

  /** Waits for the child to reach the armed `point`. */
  at(point: string, timeoutMs?: number): Promise<Message> {
    return this.waitFor((m) => m.event === "at" && m.point === point, timeoutMs);
  }

  script(steps: unknown[]) {
    return this.call({ op: "script", script: { steps } });
  }

  arm(point: string, action: "kill" | "hold", nth = 1) {
    return this.call({ op: "arm", point, action, nth });
  }

  release(point: string) {
    return this.call({ op: "release", point });
  }

  /** SIGKILL, from outside: a death no handler sees. */
  kill(): Promise<string> {
    this.proc.kill("SIGKILL");
    return this.exited;
  }

  async stop() {
    if (this.proc.exitCode === null && this.proc.signalCode === null) {
      this.post({ op: "exit" });
      await Promise.race([this.exited, new Promise((r) => setTimeout(r, 10_000))]);
      if (this.proc.exitCode === null && this.proc.signalCode === null) await this.kill();
    }
  }
}

/**
 * A Work with its branch and `n` chats in it, none with a turn yet (a chat the writer just
 * opened). `mode` is the chats' write mode.
 */
export async function seedWorkWithChats(
  h: Awaited<ReturnType<typeof openHarness>>,
  label: string,
  mode: "direct" | "draft",
  chats = 1,
) {
  const seeded = await h.seedWork(label);
  // seedWork's own chat already has a finished turn; drop it so the chat starts empty.
  await h.raw`delete from thread_works where thread_id=${seeded.threadId}`;
  await h.raw`delete from turns where thread_id=${seeded.threadId}`;
  await h.raw`delete from threads where id=${seeded.threadId}`;
  const threadIds: string[] = [];
  for (let i = 0; i < chats; i++) {
    const id = randomUUID();
    await h.raw`
      insert into threads(id,root_thread_id,project_id,created_by_user_id,title,kind,status,ai_write_mode)
      values (${id},${id},${h.ids.project},${h.ids.user},${`${label}-${i}`},'primary','idle',${mode})`;
    await h.raw`insert into thread_works(thread_id,work_id,project_id,is_primary) values (${id},${seeded.workId},${h.ids.project},true)`;
    threadIds.push(id);
  }
  return { ...seeded, threadIds };
}

/** The drafts harness over `url`, its source named `manuscript` so a model's `manuscript://` paths resolve. */
export async function openModelEditHarness(url: string) {
  const h = await openHarness(url);
  await h.raw`update context_sources set slug='manuscript' where id=${h.ids.source}`;
  return h;
}

type Harness = Awaited<ReturnType<typeof openModelEditHarness>>;

/** Waits until the chat's latest assistant turn is complete, errored or interrupted. */
export async function waitForAssistantTurn(h: Harness, threadId: string, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const [turn] = await h.raw<{ id: string; status: string }[]>`
      select id, status from turns
      where thread_id=${threadId} and role='assistant' and status not in ('pending','streaming','running')
      order by position desc limit 1`;
    if (turn) return turn;
    if (Date.now() > until) throw new Error("the assistant turn did not settle");
    await new Promise((done) => setTimeout(done, 100));
  }
}

/** What a case asserts on: the stored rows for one chat and document. */
export async function rows(h: Harness, threadId: string, documentId: string) {
  return {
    text: await h.liveText(documentId),
    turns:
      await h.raw`select role, status from turns where thread_id=${threadId} order by position`,
    blocks: await h.raw`
      select b.block_type, b.content->>'toolCallId' as call, left(b.content::text, 160) as content
      from turn_blocks b join turns t on t.id=b.turn_id where t.thread_id=${threadId}
      order by t.position, b.sequence`,
    edits:
      await h.raw`select tool_call_id, command_id, kind from document_edits where document_id=${documentId} order by created_at`,
    commands:
      await h.raw`select id, kind, left(outcome::text,120) as outcome from document_commands where kind='model_edit'`,
  };
}

/** The arguments a scripted model uses to insert `content` into the document at `path`. */
export const insertCall = (id: string, path: string, content: string) => ({
  id,
  name: "write",
  args: { command: "insert", path, content },
});

export type CaseContext = {
  h: Harness;
  url: string;
  /** Starts a child; every child a case starts is stopped when it ends. */
  start(): Promise<Child>;
};

export type ModelEditCase = {
  name: string;
  /** What a passing run shows, in one sentence. */
  expected: string;
  run(ctx: CaseContext): Promise<void>;
};

/**
 * Runs each case against one scratch database (a case seeds its own Work, so cases do not
 * disturb each other) and exits nonzero if any fails. A case's children are stopped afterwards.
 */
export async function runCases(probe: string, cases: readonly ModelEditCase[]): Promise<void> {
  const started = Date.now();
  const scratch = await createScratchDatabase();
  const h = await openModelEditHarness(scratch.url);
  let failed = 0;
  try {
    for (const modelEditCase of cases) {
      const children: Child[] = [];
      const at = Date.now();
      try {
        await modelEditCase.run({
          h,
          url: scratch.url,
          start: async () => {
            const child = await Child.start(scratch.url);
            children.push(child);
            return child;
          },
        });
        console.log(`PASS ${modelEditCase.name} (${((Date.now() - at) / 1000).toFixed(1)}s)`);
        console.log(`  ${modelEditCase.expected}`);
      } catch (error) {
        failed += 1;
        console.log(`FAIL ${modelEditCase.name} (${((Date.now() - at) / 1000).toFixed(1)}s)`);
        console.log(`  ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await Promise.all(children.map((child) => child.stop()));
      }
    }
  } finally {
    await h.close();
    await scratch.drop();
  }
  console.log(
    `${probe}: ${cases.length - failed}/${cases.length} passed in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
  process.exit(failed);
}

/** A Work with one chat and a live document holding `text`, for one case. */
export async function seedCase(
  h: Harness,
  label: string,
  mode: "direct" | "draft",
  text = "Live seed.",
) {
  const work = await seedWorkWithChats(h, label, mode);
  const doc = await h.seedDocument(label, text);
  const [{ name }] = await h.raw<
    { name: string }[]
  >`select name from documents where id=${doc.documentId}`;
  const path = `manuscript://${name}`;
  return { work, thread: work.threadIds[0] as string, documentId: doc.documentId as string, path };
}

/** Sends the chat a message as the writer; the run starts behind it. */
export function send(child: Child, h: Harness, threadId: string, text = "go") {
  return child.call({ op: "send", threadId, userId: h.ids.user, text });
}
