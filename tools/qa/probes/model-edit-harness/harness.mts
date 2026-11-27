import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { modelEditIds } from "../../../../apps/server/server/shared/model-edit-ids.ts";
import { createScratchDatabase, openHarness } from "./scratch.mts";

export { createScratchDatabase, openHarness };

const CHILD_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "child.mts");

let bundled: Promise<string> | undefined;

function childBundle(): Promise<string> {
  bundled ??= (async () => {
    const outdir = join(tmpdir(), `model-edit-child-${process.pid}`);
    process.once("exit", () => rmSync(outdir, { recursive: true, force: true }));
    await build({
      entryPoints: { child: CHILD_SOURCE },
      bundle: true,
      platform: "node",
      format: "esm",
      outdir,
      outExtension: { ".js": ".mjs" },
      logLevel: "warning",
      plugins: [
        {
          name: "external-packages",
          setup(b) {
            b.onResolve({ filter: /^[^./]/ }, async (args) => {
              if (args.path.startsWith("#")) return { path: args.path, external: true };
              if (args.pluginData === "inner") return null;
              const found = await b.resolve(args.path, {
                resolveDir: args.resolveDir,
                kind: args.kind,
                pluginData: "inner",
              });
              // A published package under our scope (mars-schema's CommonJS WASM loader) must stay
              // external too: only workspace source, which resolves outside node_modules, is inlined.
              if (found.errors.length || !found.path.includes("/node_modules/")) return null;
              return { path: found.path, external: true };
            });
          },
        },
      ],
    });
    return join(outdir, "child.mjs");
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

export class Child {
  readonly exited: Promise<string>;
  private readonly lines: Message[] = [];
  private readonly waiters: (() => void)[] = [];
  private nextId = 1;
  private readonly proc: ChildProcess;
  readonly name = `mec-${randomUUID()}`;

  private constructor(url: string, bundle: string, pool: number) {
    this.proc = spawn(process.execPath, [bundle], {
      env: { ...process.env, DATABASE_URL: url, CHILD_NAME: this.name, CHILD_POOL: String(pool) },
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

  static async start(url: string, pool = 2): Promise<Child> {
    const child = new Child(url, await childBundle(), pool);
    await child.waitFor((m) => m.event === "ready", 60_000);
    return child;
  }

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

  async died(timeoutMs = 15_000): Promise<string> {
    const outcome = await Promise.race([
      this.exited,
      new Promise<string>((done) => setTimeout(() => done("still running"), timeoutMs)),
    ]);
    return outcome;
  }

  timeout(tool: string, ms: number) {
    return this.call({ op: "timeout", tool, ms });
  }

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

export async function seedWorkWithChats(
  h: Awaited<ReturnType<typeof openHarness>>,
  label: string,
  mode: "direct" | "draft",
  chats = 1,
) {
  const seeded = await h.seedWork(label);
  await h.raw`insert into context_sources(work_id,slug,scope) values (${seeded.workId},'scratch','work')`;
  await h.raw`delete from thread_works where thread_id=${seeded.threadId}`;
  await h.raw`delete from turns where thread_id=${seeded.threadId}`;
  await h.raw`delete from threads where id=${seeded.threadId}`;
  const threadIds: string[] = [];
  for (let i = 0; i < chats; i++) {
    const id = randomUUID();
    await h.raw`
      insert into threads(id,root_thread_id,project_id,created_by_user_id,title,kind,ai_write_mode)
      values (${id},${id},${h.ids.project},${h.ids.user},${`${label}-${i}`},'primary',${mode})`;
    await h.raw`insert into thread_works(thread_id,work_id,project_id,is_primary) values (${id},${seeded.workId},${h.ids.project},true)`;
    threadIds.push(id);
  }
  return { ...seeded, threadIds };
}

export async function openModelEditHarness(url: string) {
  const h = await openHarness(url);
  await h.raw`update context_sources set slug='manuscript' where id=${h.ids.source}`;
  await h.raw`
    insert into works(project_id,created_by_user_id,name,handle,is_no_work)
    values (${h.ids.project},${h.ids.user},'No Work',null,true)`;
  return h;
}

type Harness = Awaited<ReturnType<typeof openModelEditHarness>>;

export async function waitForAssistantTurn(
  h: Harness,
  threadId: string,
  { count = 1, timeoutMs = 15_000 } = {},
) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const turns = await h.raw<{ id: string; status: string }[]>`
      select id, status from turns where thread_id=${threadId} and role='assistant'
      order by position`;
    const last = turns.at(-1);
    if (last && turns.length >= count && !["pending", "streaming", "running"].includes(last.status))
      return last;
    if (Date.now() > until) throw new Error("the assistant turn did not settle");
    await new Promise((done) => setTimeout(done, 100));
  }
}

function resultLabel(content: { result?: Record<string, unknown>; content?: unknown }): string {
  const result = content.result ?? {};
  const message = String(result.message ?? "");
  if (/did not run/.test(message)) return "did_not_run";
  if (/timed out/.test(message)) return "timeout";
  return String(result.status ?? result.code ?? "unknown");
}

export async function frontierSources(h: Harness, threadId: string) {
  const found = await h.raw<{ source: string }[]>`
    select source_block_id as source from observation_frontiers
    where thread_id=${threadId} and room_key <> 'tree' order by recorded_seq`;
  return found.map((row) => row.source);
}

export async function resultBlockIds(h: Harness, threadId: string) {
  const found = await h.raw<{ id: string }[]>`
    select b.id from turn_blocks b join turns t on t.id=b.turn_id
    where t.thread_id=${threadId} and b.block_type='tool_result' order by t.position, b.sequence`;
  return found.map((row) => row.id);
}

async function commandStatuses(h: Harness, threadId: string) {
  const uses = await h.raw<{ response: string; call: string }[]>`
    select b.model_response_id as response, b.content->>'toolCallId' as call
    from turn_blocks b join turns t on t.id=b.turn_id
    where t.thread_id=${threadId} and b.block_type='tool_use' and b.model_response_id is not null
    order by t.position, b.sequence`;
  const statuses: string[] = [];
  for (const use of uses) {
    const { commandId } = modelEditIds({ responseId: use.response, toolCallId: use.call });
    const [row] = await h.raw<{ status: string }[]>`
      select outcome->>'status' as status from commands where id=${commandId}`;
    if (row) statuses.push(row.status);
  }
  return statuses;
}

export async function state(h: Harness, threadId: string, documentId: string) {
  const results = await h.raw<{ call: string; content: Parameters<typeof resultLabel>[0] }[]>`
    select b.content->>'toolCallId' as call, b.content as content
    from turn_blocks b join turns t on t.id=b.turn_id
    where t.thread_id=${threadId} and b.block_type='tool_result' order by t.position, b.sequence`;
  return {
    doc: await h.liveParagraphs(documentId),
    turns: (
      await h.raw<{ status: string }[]>`
        select status from turns where thread_id=${threadId} and role='assistant' order by position`
    ).map((turn) => turn.status),
    results: results.map((r) => `${r.call}:${resultLabel(r.content)}`),
    edits: (
      await h.raw<{ call: string }[]>`
        select e.tool_call_id as call from document_edits e
        where e.document_id=${documentId} and e.tool_call_id in (
          select b.content->>'toolCallId' from turn_blocks b join turns t on t.id=b.turn_id
          where t.thread_id=${threadId} and b.block_type='tool_use')
        order by e.created_at`
    ).map((edit) => edit.call),
    commands: await commandStatuses(h, threadId),
  };
}

export async function documentsNamed(h: Harness, prefix: string) {
  return h.raw<{ id: string; name: string; deleted: boolean }[]>`
    select id, name, trashed_at is not null as deleted from tree_nodes
    where context_source_id=${h.ids.source} and kind='document' and name like ${`${prefix}%`}
    order by name`;
}

export async function dropRunClaim(h: Harness, child: Child) {
  const dropped = await h.raw`
    select pg_terminate_backend(a.pid) from pg_locks l join pg_stat_activity a on a.pid=l.pid
    where l.locktype='advisory' and l.granted and a.application_name=${child.name}`;
  if (dropped.length === 0) throw new Error("the child holds no run claim");
}

export async function waitForKeyWaiter(h: Harness, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const [waiting] = await h.raw`
      select 1 from pg_stat_activity
      where datname=current_database() and wait_event_type='Lock' and query ilike '%insert into "commands"%'`;
    if (waiting) return;
    if (Date.now() > until) throw new Error("no resolve waited on a command key");
    await new Promise((done) => setTimeout(done, 50));
  }
}

export const insertCall = (id: string, path: string, content: string) => ({
  id,
  name: "write",
  args: { command: "insert", path, content },
});

export type CaseContext = {
  h: Harness;
  url: string;
  start(pool?: number): Promise<Child>;
};

export type ModelEditCase = {
  name: string;
  expected: string;
  run(ctx: CaseContext): Promise<void>;
};

export async function runCases(probe: string, cases: readonly ModelEditCase[]): Promise<void> {
  const started = Date.now();
  const scratch = await createScratchDatabase();
  const h = await openModelEditHarness(scratch.url);
  let failed = 0;
  try {
    for (const modelEditCase of cases) {
      if (process.env.CASE && !modelEditCase.name.includes(process.env.CASE)) continue;
      const children: Child[] = [];
      const at = Date.now();
      try {
        await modelEditCase.run({
          h,
          url: scratch.url,
          start: async (pool) => {
            const child = await Child.start(scratch.url, pool);
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

export async function namePath(h: Harness, documentId: string) {
  const [{ stem }] = await h.raw<{ stem: string }[]>`
    select stem from tree_nodes where id=${documentId}`;
  return `manuscript://${stem}`;
}

export async function seedCase(
  h: Harness,
  label: string,
  mode: "direct" | "draft",
  text = "Live seed.",
) {
  const work = await seedWorkWithChats(h, label, mode);
  const doc = await h.seedDocument(label, text);
  const path = await namePath(h, doc.documentId);
  return { work, thread: work.threadIds[0] as string, documentId: doc.documentId as string, path };
}

export function send(
  child: Child,
  h: Harness,
  threadId: string,
  text = "go",
  disallowedTools?: string[],
) {
  return child.call({ op: "send", threadId, userId: h.ids.user, text, disallowedTools });
}
