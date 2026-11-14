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
import { materializeDraftRead } from "../../../../apps/server/server/domains/collab/domain/draft-store.ts";
import { modelEditIds } from "../../../../apps/server/server/shared/model-edit-ids.ts";
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
  /** The application name of this process's connections. */
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

  /** `pool` is the child's connection count: 2 unless a case runs two commands in one process. */
  static async start(url: string, pool = 2): Promise<Child> {
    const child = new Child(url, await childBundle(), pool);
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

  /** Waits for the child to die, as the case's kill point should make it; fails if it does not. */
  async died(timeoutMs = 15_000): Promise<string> {
    const outcome = await Promise.race([
      this.exited,
      new Promise<string>((done) => setTimeout(() => done("still running"), timeoutMs)),
    ]);
    return outcome;
  }

  /** Shortens a tool's registered timeout in this process. */
  timeout(tool: string, ms: number) {
    return this.call({ op: "timeout", tool, ms });
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
  await h.raw`insert into context_sources(work_id,name,slug,scope) values (${seeded.workId},'Scratch','scratch','work')`;
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

/**
 * The drafts harness over `url`, shaped like a project the app made: the source is named
 * `manuscript` so a model's `manuscript://` paths resolve, and the project has its "no Work" row
 * (a model's `undo` reads it).
 */
export async function openModelEditHarness(url: string) {
  const h = await openHarness(url);
  await h.raw`update context_sources set slug='manuscript' where id=${h.ids.source}`;
  await h.raw`
    insert into works(project_id,created_by_user_id,name,handle,is_no_work)
    values (${h.ids.project},${h.ids.user},'No Work',null,true)`;
  return h;
}

type Harness = Awaited<ReturnType<typeof openModelEditHarness>>;

/**
 * Waits until the chat has `count` assistant turns, the latest complete, errored or interrupted.
 * A takeover adds a turn, so a case that expects the old run's turn and the new one passes 2.
 */
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

/** The paragraphs of a document's `prosemirror` text, as its XML string holds them. */
const paragraphs = (xml: string) =>
  [...xml.matchAll(/<paragraph>(.*?)<\/paragraph>/g)].map((m) => m[1] as string);

/** One result block's outcome in a word: what the model was shown the call did. */
function resultLabel(content: { result?: Record<string, unknown>; content?: unknown }): string {
  const result = content.result ?? {};
  const message = String(result.message ?? "");
  if (/did not run/.test(message)) return "did_not_run";
  if (/timed out/.test(message)) return "timeout";
  return String(result.phase ?? result.status ?? result.code ?? "unknown");
}

/**
 * What the model was shown, from collab's evidence rows: the source block id of each of the
 * chat's document observation frontiers (the `tree` room holds the names a result showed, not a
 * document), oldest first. This one function reads them, so a change to
 * where the evidence lives changes it alone; `model-edit-evidence` asserts on it.
 */
export async function frontierSources(h: Harness, threadId: string) {
  const found = await h.raw<{ source: string }[]>`
    select source_block_id as source from observation_frontiers
    where thread_id=${threadId} and room_key <> 'tree' order by recorded_seq`;
  return found.map((row) => row.source);
}

/** The ids of the chat's `tool_result` blocks, in order. */
export async function resultBlockIds(h: Harness, threadId: string) {
  const found = await h.raw<{ id: string }[]>`
    select b.id from turn_blocks b join turns t on t.id=b.turn_id
    where t.thread_id=${threadId} and b.block_type='tool_result' order by t.position, b.sequence`;
  return found.map((row) => row.id);
}

/**
 * The statuses of the model-edit command rows of this chat's calls, in call order. A command's id
 * comes from the stored response's id and the call id.
 */
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

/**
 * What a case asserts on, from stored rows only: the live document's paragraphs, the assistant
 * turns' statuses, each result block's outcome in call order, the edit receipts' call ids and
 * the model-edit command rows' statuses.
 */
export async function state(h: Harness, threadId: string, documentId: string) {
  const results = await h.raw<{ call: string; content: Parameters<typeof resultLabel>[0] }[]>`
    select b.content->>'toolCallId' as call, b.content as content
    from turn_blocks b join turns t on t.id=b.turn_id
    where t.thread_id=${threadId} and b.block_type='tool_result' order by t.position, b.sequence`;
  return {
    doc: paragraphs(await h.liveText(documentId)),
    turns: (
      await h.raw<{ status: string }[]>`
        select status from turns where thread_id=${threadId} and role='assistant' order by position`
    ).map((turn) => turn.status),
    results: results.map((r) => `${r.call}:${resultLabel(r.content)}`),
    // The receipts of this chat's calls: another chat on the document has its own.
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

/** A writer's replica of the draft as committed now; the caller destroys it. */
export async function draftDoc(h: Harness, draftId: string) {
  const read = await h.store.readDraftAt(draftId);
  if (!read) throw new Error(`Draft ${draftId} is missing`);
  return materializeDraftRead(read);
}

/** The document's Work drafts as stored, oldest first: each one's status and paragraphs. */
export async function drafts(h: Harness, documentId: string) {
  const found = await h.raw<{ id: string; status: string }[]>`
    select id, status from document_drafts
    where document_id=${documentId} and kind='work_draft' order by created_at, id`;
  return Promise.all(
    found.map(async (draft) => ({
      status: draft.status,
      doc: paragraphs((await h.readDraft(draft.id)).text),
    })),
  );
}

/** The probe's source's documents whose name starts with `prefix`: by name, and whether each is in Trash. */
export async function documentsNamed(h: Harness, prefix: string) {
  return h.raw<{ id: string; name: string; deleted: boolean }[]>`
    select id, name, trashed_at is not null as deleted from tree_nodes
    where context_source_id=${h.ids.source} and kind='document' and name like ${`${prefix}%`}
    order by name`;
}

/**
 * Cuts a child's session claim on its chats' runs, as a dropped connection does: its advisory
 * locks go, so another process can take the runs over while this one is alive and held.
 */
export async function dropRunClaim(h: Harness, child: Child) {
  const dropped = await h.raw`
    select pg_terminate_backend(a.pid) from pg_locks l join pg_stat_activity a on a.pid=l.pid
    where l.locktype='advisory' and l.granted and a.application_name=${child.name}`;
  if (dropped.length === 0) throw new Error("the child holds no run claim");
}

/** Waits for a connection blocked on a `commands` insert: a resolve waiting on a key. */
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
  start(pool?: number): Promise<Child>;
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

/** The document's `manuscript://` path: its name without the extension, as the model is shown it. */
export async function namePath(h: Harness, documentId: string) {
  const [{ stem }] = await h.raw<{ stem: string }[]>`
    select stem from tree_nodes where id=${documentId}`;
  return `manuscript://${stem}`;
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
  const path = await namePath(h, doc.documentId);
  return { work, thread: work.threadIds[0] as string, documentId: doc.documentId as string, path };
}

/** Sends the chat a message as the writer; the run starts behind it. */
export function send(
  child: Child,
  h: Harness,
  threadId: string,
  text = "go",
  disallowedTools?: string[],
) {
  return child.call({ op: "send", threadId, userId: h.ids.user, text, disallowedTools });
}
