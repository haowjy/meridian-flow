/**
 * The rule on a running server: a file Mars reports an error on is left out of its package's
 * Save (listed unavailable, so no chat can bind it), and the three read-only built-in Agents refuse a write, as Critic
 * itself and as children Muse spawns. Needs a stack on the mock provider:
 *
 *   LIVE_TEST_MODEL= MODEL_PROVIDER=mock pnpm dev
 *   pnpm exec tsx tools/qa/agents-through-mars/server-gate.mts
 *
 * `MF_SERVER_URL` and `DATABASE_URL` override the stack and database this checkout's `pnpm dev`
 * would use. Writes an Agent file into the default project's Agents source and chats there.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import postgres from "postgres";
import { LOCAL_DEV_POSTGRES_PORT } from "../../dev/lib/dev-db.ts";
import { resolveCurrentRepoRoot } from "../../dev/lib/dev-env.ts";

const root = resolveCurrentRepoRoot();
/** stdout and stderr together: `thread send` reports its tool results on stderr. */
const mf = (...args: string[]) => {
  const run = spawnSync("./mf", args, { cwd: root, encoding: "utf8" });
  const output = `${run.stdout}${run.stderr}`;
  if (run.status !== 0) throw new Error(output);
  return output;
};
const serverUrl = () => {
  if (process.env.MF_SERVER_URL) return process.env.MF_SERVER_URL;
  const out = execFileSync(`${root}/node_modules/.bin/portless`, ["list"], { encoding: "utf8" });
  const match = new RegExp(`https://${basename(root)}\\.server\\.[^\\s]+`).exec(out);
  if (!match) throw new Error("No server route for this checkout; run pnpm dev");
  return match[0];
};
const http = (method: string, path: string, body?: unknown) => {
  const out = execFileSync(
    "curl",
    [
      "-sk",
      "-X",
      method,
      "-H",
      "content-type: application/json",
      "-w",
      "\n%{http_code}",
      ...(body === undefined ? [] : ["-d", JSON.stringify(body)]),
      `${serverUrl()}${path}`,
    ],
    { encoding: "utf8" },
  );
  const cut = out.lastIndexOf("\n");
  return { status: Number(out.slice(cut + 1)), body: out.slice(0, cut) };
};
const value = (text: string) => JSON.parse(text).value;

const sql = postgres(
  process.env.DATABASE_URL ??
    `postgresql://postgres:postgres@127.0.0.1:${LOCAL_DEV_POSTGRES_PORT}/meridian_${basename(root)}`,
  { max: 1 },
);
const failures: string[] = [];
const check = async (name: string, run: () => Promise<void>) => {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`FAIL ${name}\n     ${error instanceof Error ? error.message : String(error)}`);
  }
};
const threadId = (created: string) => /([0-9a-f-]{36})/.exec(created)?.[1] as string;

try {
  await check("a file with an Error is left out of the Save and no chat binds it", async () => {
    const slug = `gate-${Date.now().toString(36)}`;
    const path = `agents://agents/${slug}.md`;
    const projectId = mf("project", "default").trim();
    mf(
      "doc",
      "put",
      path,
      // `=` form: the parser reads a separate value that starts with a dash as another option.
      "--text=---\nname: Gate\neffort: 7\n---\n\nBody.\n",
    );
    try {
      const saved = http("POST", "/api/agents/save", {
        projectId,
        packages: [{ level: "project", folder: "" }],
      });
      assert.equal(saved.status, 200, "a Save is a result, never an HTTP error");
      const [outcome] = value(saved.body).outcomes;
      assert.equal(outcome.outcome, "saved");
      assert.ok(outcome.leftOut.includes(`agents/${slug}.md`), `not left out: ${outcome.leftOut}`);
      assert.equal(outcome.findings[0]?.severity, "error", "its error is first on the result");
      const listed = value(http("GET", `/api/agents?projectId=${projectId}`).body).agents.find(
        (agent: { slug: string }) => agent.slug === slug,
      );
      assert.ok(listed?.unavailableReasons.length > 0, "Agent is not listed with reasons");
      const created = http("POST", "/api/threads", {
        id: randomUUID(),
        projectId,
        agentSelection: listed.selection,
        overrides: { model: null, effort: null },
      });
      assert.ok(created.status >= 400, `thread creation was not refused: ${created.status}`);
    } finally {
      mf("doc", "rm", path);
    }
  });

  await check(
    "Critic's write to a manuscript is refused and the document does not exist",
    async () => {
      const id = threadId(mf("thread", "create", "--agent", "critic", "--title", "gate critic"));
      const sent = mf(
        "thread",
        "send",
        id,
        "write a scene",
        "--mock",
        "@tools/mf/fixtures/mock-write.json",
      );
      assert.match(sent, /permission_denied/);
      assert.match(sent, /agent_read_only/);
      assert.throws(() => mf("doc", "read", "manuscript://Scene"), /No live document/);
    },
  );

  await check("children Muse spawns that are read-only are bound read", async () => {
    const id = threadId(mf("thread", "create", "--agent", "muse", "--title", "gate muse"));
    const spawn = (agent: string) => ({
      name: "spawn",
      args: { agent, prompt: "Check chapter 1.", name: `${agent} check` },
    });
    const script = JSON.stringify({
      steps: [
        {
          text: "Asking for checks.",
          toolCalls: [spawn("continuity-checker"), spawn("reader-sim")],
        },
        { text: "Done." },
      ],
    });
    mf("thread", "send", id, "check chapter 1", "--mock", script);
    const rows = await sql<{ name: string; permission: string }[]>`
      select t.title as name, b.configuration->>'permission' as permission
      from threads t join thread_agent_bindings b on b.thread_id = t.id
      where t.root_thread_id = ${id} and t.id <> ${id}`;
    assert.equal(rows.length, 2, `expected two children, found ${JSON.stringify(rows)}`);
    for (const row of rows) assert.equal(row.permission, "read", `${row.name} is not read-only`);
  });
} finally {
  await sql.end();
}
if (failures.length) {
  console.log(`\n${failures.length} failed: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("\nall passed");
