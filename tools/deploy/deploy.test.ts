import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const execFileAsync = promisify(execFile);
const manifest = JSON.stringify({
  version: "1.2.3",
  tag: "v1.2.3",
  sha: "a".repeat(40),
  images: Object.fromEntries(
    ["server", "app", "www", "ingress"].map((name) => [
      name,
      {
        repository: `ghcr.io/haowjy/meridian-flow-${name}`,
        digest: `sha256:${"b".repeat(64)}`,
        ref: `ghcr.io/haowjy/meridian-flow-${name}@sha256:${"b".repeat(64)}`,
      },
    ]),
  ),
});
const fakeCli = `#!/usr/bin/env node
const fs = require('node:fs');
const statePath = process.env.FAKE_RAILWAY_STATE;
let state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
const args = process.argv.slice(2); const scenario = process.env.SCENARIO;
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
if (args[0] === '--version') { console.log('railway 5.62.1'); process.exit(0); }
const service = args[args.indexOf('-s') + 1] || (args[0] === 'environment' ? args[args.indexOf('--service-config') + 1] : undefined);
if (args[0] === 'environment' && args[1] === 'edit') {
  fs.appendFileSync(process.env.FAKE_RAILWAY_LOG, args.join(' ') + '\\n');
  if (scenario !== 'no-auto') { state[service] = {id: service + '-1', status: 'DEPLOYING', reads: 0}; save(); }
  process.exit(0);
}
if (args[0] === 'redeploy') {
  state[service] = scenario === 'fallback-race'
    ? {id: service + '-late', status: 'REMOVED', reads: 0, pendingRedeploy: true}
    : {id: service + '-1', status: 'DEPLOYING', reads: 0};
  save(); console.log('{}'); process.exit(0);
}
if (args[0] === 'deployment' && args[1] === 'list') {
  state.listCounts ??= {}; state.listCounts[service] = (state.listCounts[service] || 0) + 1;
  const deployment = state[service];
  if (!deployment) {
    if (scenario === 'fallback-race' && state.listCounts[service] >= 2) {
      state[service] = {id: service + '-late', status: 'REMOVED', reads: 0}; save();
      console.log(JSON.stringify([state[service]])); process.exit(0);
    }
    save(); console.log('[]'); process.exit(0);
  }
  deployment.reads++;
  if (deployment.pendingRedeploy && deployment.reads >= 2) {
    state[service] = {id: service + '-redeploy', status: 'SUCCESS', reads: 0};
    save(); console.log(JSON.stringify([state[service]])); process.exit(0);
  }
  if (['failure', 'removed', 'skipped', 'completed'].includes(scenario) && deployment.reads >= 2) deployment.status = scenario === 'removed' ? 'REMOVED' : scenario === 'skipped' ? 'SKIPPED' : scenario === 'completed' ? 'COMPLETED' : 'FAILED';
  else if (scenario !== 'timeout' && deployment.reads >= 2) deployment.status = 'SUCCESS';
  save(); console.log(JSON.stringify([deployment])); process.exit(0);
}
console.error('unexpected command', args); process.exit(2);
`;
async function run(scenario: string) {
  let snapshotName = "";
  const neon = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    response.setHeader("content-type", "application/json");
    if (request.method === "POST") {
      snapshotName = url.searchParams.get("name") ?? "";
      response.end(JSON.stringify({ snapshot: { id: "snap-123" }, operation: { id: "op-1" } }));
    } else if (url.pathname.endsWith("/operations/op-1")) {
      response.end(JSON.stringify({ operation: { status: "finished", failures_count: 0 } }));
    } else {
      response.end(
        JSON.stringify({
          snapshots: [{ id: "snap-123", name: snapshotName, source_branch_id: "branch-1" }],
        }),
      );
    }
  });
  await new Promise<void>((resolve) => neon.listen(0, "127.0.0.1", resolve));
  const address = neon.address();
  if (!address || typeof address === "string") throw new Error("fake Neon server did not bind");
  const dir = mkdtempSync(join(tmpdir(), "meridian-deploy-test-"));
  const bin = join(dir, "bin");
  const state = join(dir, "state.json");
  const commandLog = join(dir, "railway.log");
  const manifestPath = join(dir, "manifest.json");
  const fake = join(bin, "railway");
  const oldPath = process.env.PATH ?? "";
  try {
    mkdirSync(bin);
    writeFileSync(fake, fakeCli);
    chmodSync(fake, 0o755);
    writeFileSync(manifestPath, manifest);
    const output = await execFileAsync(
      process.execPath,
      [join(root, "tools/deploy/deploy.ts"), "staging", manifestPath],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${oldPath}`,
          RAILWAY_TOKEN: "test-token",
          NEON_API_KEY: "test-key",
          NEON_PROJECT_ID: "project-1",
          NEON_BRANCH_ID: "branch-1",
          NEON_API_BASE_URL: `http://127.0.0.1:${address.port}`,
          FAKE_RAILWAY_STATE: state,
          FAKE_RAILWAY_LOG: commandLog,
          SCENARIO: scenario,
          DEPLOY_DETECT_MS: scenario === "fallback-race" ? "0" : "24",
          DEPLOY_REDEPLOY_DETECT_MS: scenario === "fallback-race" ? "400" : "24",
          DEPLOY_TIMEOUT_MS: "24",
          DEPLOY_POLL_MS: "2",
        },
        encoding: "utf8",
      },
    );
    return `${output.stdout}\n${readFileSync(commandLog, "utf8")}`;
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    const log = existsSync(commandLog) ? readFileSync(commandLog, "utf8") : "";
    return `${e.stderr ?? ""}${e.stdout ?? ""}${log}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => neon.close(() => resolve()));
  }
}

describe("Railway deploy seam", () => {
  it("promotes server before the remaining images and reports deployments", async () => {
    const output = await run("success");
    expect(output).toMatch(/server\s+server-1/);
    expect(output).toMatch(/ingress\s+ingress-1/);
    expect(output).toMatch(
      /--service-config server source.image ghcr\.io\/haowjy\/meridian-flow-server@sha256:[a-f0-9]{64} --service-config server variables\.MERIDIAN_BACKUP_REF\.value neon-snapshot:snap-123:release=a{40}/,
    );
  });
  it("fails with the exact inspection command for failed deployments", async () => {
    expect(await run("failure")).toContain(
      "railway logs -s server -e staging server-1 --deployment",
    );
  });
  it.each([
    "removed",
    "skipped",
    "completed",
  ])("fails immediately when a deployment is %s", async (status) => {
    expect(await run(status)).toContain(`server-1 ${status.toUpperCase()}`);
  });
  it("falls back to redeploy when changing source.image did not trigger a deployment", async () => {
    expect(await run("no-auto")).toMatch(/app\s+app-1/);
  });
  it("waits for the fallback deployment instead of a late image-edit deployment", async () => {
    expect(await run("fallback-race")).toMatch(/server\s+server-redeploy/);
  });
  it("fails boundedly when deployments never reach a terminal state", async () => {
    expect(await run("timeout")).toContain("server-1 timed out");
  });
});
