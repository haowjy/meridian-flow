import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
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
  if (scenario !== 'no-auto') { state[service] = {id: service + '-1', status: 'DEPLOYING', reads: 0}; save(); }
  process.exit(0);
}
if (args[0] === 'redeploy') { state[service] = {id: service + '-1', status: 'DEPLOYING', reads: 0}; save(); console.log('{}'); process.exit(0); }
if (args[0] === 'deployment' && args[1] === 'list') {
  const deployment = state[service];
  if (!deployment) { console.log('[]'); process.exit(0); }
  deployment.reads++;
  if (scenario === 'failure' && deployment.reads >= 2) deployment.status = 'FAILED';
  else if (scenario !== 'timeout' && deployment.reads >= 2) deployment.status = 'SUCCESS';
  save(); console.log(JSON.stringify([deployment])); process.exit(0);
}
console.error('unexpected command', args); process.exit(2);
`;
function run(scenario: string) {
  const dir = mkdtempSync(join(tmpdir(), "meridian-deploy-test-"));
  const bin = join(dir, "bin");
  const state = join(dir, "state.json");
  const manifestPath = join(dir, "manifest.json");
  const fake = join(bin, "railway");
  const oldPath = process.env.PATH ?? "";
  try {
    mkdirSync(bin);
    writeFileSync(fake, fakeCli);
    chmodSync(fake, 0o755);
    writeFileSync(manifestPath, manifest);
    const output = execFileSync(
      process.execPath,
      [join(root, "tools/deploy/deploy.ts"), "staging", manifestPath],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${oldPath}`,
          RAILWAY_TOKEN: "test-token",
          FAKE_RAILWAY_STATE: state,
          SCENARIO: scenario,
          DEPLOY_DETECT_MS: "24",
          DEPLOY_TIMEOUT_MS: "24",
          DEPLOY_POLL_MS: "2",
        },
        encoding: "utf8",
        stdio: "pipe",
      },
    );
    return output;
  } catch (error) {
    const e = error as { stdout?: Buffer; stderr?: Buffer; status?: number };
    return `${e.stderr?.toString() ?? ""}${e.stdout?.toString() ?? ""}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Railway deploy seam", () => {
  it("promotes server before the remaining images and reports deployments", () => {
    const output = run("success");
    expect(output).toMatch(/server\s+server-1/);
    expect(output).toMatch(/ingress\s+ingress-1/);
  });
  it("fails with the exact inspection command for failed deployments", () => {
    expect(run("failure")).toContain("railway logs -s server -e staging server-1 --deployment");
  });
  it("falls back to redeploy when changing source.image did not trigger a deployment", () => {
    expect(run("no-auto")).toMatch(/app\s+app-1/);
  });
  it("fails boundedly when deployments never reach a terminal state", () => {
    expect(run("timeout")).toContain("server-1 timed out");
  });
});
