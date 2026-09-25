/** Promote digest-pinned release images through Railway and wait for runtime deployments. */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createConfirmedSnapshot } from "./neon.ts";

type Image = { repository: string; digest: string; ref: string };
type Manifest = { version: string; tag: string; sha: string; images: Record<string, Image> };
type Deployment = { id?: string; status?: string; deploymentId?: string };
const services = ["server", "app", "www", "ingress"] as const;
const cliVersion = "5.62.1";
const timeoutMs = Number(process.env.DEPLOY_TIMEOUT_MS ?? 12 * 60_000);
const pollMs = Number(process.env.DEPLOY_POLL_MS ?? 3_000);
const detectMs = Number(process.env.DEPLOY_DETECT_MS ?? 60_000);
const terminalFailures = new Set([
  "FAILED",
  "CRASHED",
  "REMOVED",
  "SKIPPED",
  "CANCELED",
  "CANCELLED",
  "TIMED_OUT",
  "ABORTED",
  "DEACTIVATED",
  "THROTTLED",
]);

function fail(message: string): never {
  throw new Error(message);
}
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) fail(`Missing required deploy input: ${name}`);
  return value;
}
function command(args: string[], input?: string): string {
  const result = spawnSync("railway", args, { encoding: "utf8", input, env: process.env });
  if (result.error) fail(`railway ${args.join(" ")} failed: ${result.error.message}`);
  if (result.status !== 0)
    fail(
      `railway ${args.join(" ")} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`,
    );
  return result.stdout.trim();
}
function json<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fail(`Could not parse ${label} JSON from Railway: ${raw}`);
  }
}
function deploymentList(environment: string, service: string): Deployment[] {
  const parsed = json<Deployment[] | { deployments?: Deployment[] }>(
    command(["deployment", "list", "-s", service, "-e", environment, "--limit", "10", "--json"]),
    `${service} deployment list`,
  );
  return Array.isArray(parsed) ? parsed : (parsed.deployments ?? []);
}
function deploymentId(item: Deployment): string | undefined {
  return item.id ?? item.deploymentId;
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForNewDeployment(
  environment: string,
  service: string,
  previousId?: string,
): Promise<Deployment> {
  const end = Date.now() + detectMs;
  while (Date.now() < end) {
    const latest = deploymentList(environment, service)[0];
    if (latest && deploymentId(latest) && deploymentId(latest) !== previousId) return latest;
    await wait(pollMs);
  }
  command(["redeploy", "-s", service, "-e", environment, "--from-source", "-y", "--json"]);
  const redeployEnd = Date.now() + detectMs;
  while (Date.now() < redeployEnd) {
    const latest = deploymentList(environment, service)[0];
    if (latest && deploymentId(latest) && deploymentId(latest) !== previousId) return latest;
    await wait(pollMs);
  }
  fail(`${service}: no new deployment appeared after image edit and redeploy fallback`);
}
async function waitForTerminal(
  environment: string,
  service: string,
  initial: Deployment,
): Promise<string> {
  const id = deploymentId(initial);
  if (!id) fail(`${service}: Railway deployment has no id`);
  const deadline = Date.now() + timeoutMs;
  let current = initial;
  while (Date.now() < deadline) {
    const latest = deploymentList(environment, service).find((item) => deploymentId(item) === id);
    if (latest) current = latest;
    const status = (current.status ?? "").toUpperCase();
    if (status === "SUCCESS") return id;
    if (terminalFailures.has(status)) {
      fail(
        `${service}: deployment ${id} ${status}; inspect with: railway logs -s ${service} -e ${environment} ${id} --deployment`,
      );
    }
    await wait(pollMs);
  }
  fail(
    `${service}: deployment ${id} timed out after ${Math.round(timeoutMs / 1000)}s; inspect with: railway logs -s ${service} -e ${environment} ${id} --deployment`,
  );
}
async function deployService(
  environment: string,
  service: string,
  image: Image,
  backupRef?: string,
): Promise<[string, string]> {
  const previous = deploymentList(environment, service)[0];
  const previousId = previous && deploymentId(previous);
  const editArgs = [
    "environment",
    "edit",
    "-e",
    environment,
    "--service-config",
    service,
    "source.image",
    image.ref,
  ];
  if (backupRef)
    editArgs.push("--service-config", service, "variables.MERIDIAN_BACKUP_REF.value", backupRef);
  editArgs.push("-m", `Promote ${image.ref}${backupRef ? " with confirmed Neon snapshot" : ""}`);
  command(editArgs);
  const deployment = await waitForNewDeployment(environment, service, previousId);
  const id = await waitForTerminal(environment, service, deployment);
  return [service, id];
}
async function main() {
  const [environment, manifestPath] = process.argv.slice(2);
  const missing: string[] = [];
  if (!environment) missing.push("environment (staging or production)");
  if (!manifestPath) missing.push("manifest.json path");
  else if (!existsSync(manifestPath)) missing.push(`manifest file at ${manifestPath}`);
  if (!process.env.RAILWAY_TOKEN) missing.push("RAILWAY_TOKEN");
  if (!process.env.NEON_API_KEY) missing.push("NEON_API_KEY");
  if (!process.env.NEON_PROJECT_ID) missing.push("NEON_PROJECT_ID");
  if (!process.env.NEON_BRANCH_ID) missing.push("NEON_BRANCH_ID");
  if (missing.length) fail(`Missing required deploy inputs: ${missing.join(", ")}`);
  if (!["staging", "production"].includes(environment))
    fail(`Unsupported environment '${environment}' (expected staging or production)`);
  const manifest = json<Manifest>(await readFile(manifestPath, "utf8"), "release manifest");
  if (
    !/^v\d+\.\d+\.\d+(-rc\.\d+)?$/.test(manifest.tag) ||
    manifest.tag !== `v${manifest.version}` ||
    !/^[0-9a-f]{40}$/.test(manifest.sha)
  )
    fail("Manifest must include a matching version/tag and full 40-character release sha");
  for (const service of services) {
    const image = manifest.images?.[service];
    if (
      !image ||
      image.repository !== `ghcr.io/haowjy/meridian-flow-${service}` ||
      !/^sha256:[0-9a-f]{64}$/.test(image.digest) ||
      image.ref !== `${image.repository}@${image.digest}`
    )
      fail(
        `Manifest image '${service}' must contain its expected repository, sha256 digest, and matching digest ref`,
      );
  }
  // Complete the external backup before any Railway command can mutate or deploy a service.
  const ttlDays = Number(process.env.NEON_SNAPSHOT_TTL_DAYS ?? 14);
  const snapshot = await createConfirmedSnapshot({
    apiKey: requiredEnv("NEON_API_KEY"),
    projectId: requiredEnv("NEON_PROJECT_ID"),
    branchId: requiredEnv("NEON_BRANCH_ID"),
    tag: manifest.tag,
    ttlDays,
    timeoutMs: Number(process.env.NEON_OPERATION_TIMEOUT_MS ?? 120_000),
    pollMs: Number(process.env.NEON_POLL_MS ?? 1_000),
    baseUrl: process.env.NEON_API_BASE_URL,
  });
  const backupRef = `neon-snapshot:${snapshot.id}:release=${manifest.sha}`;
  const versionOutput = command(["--version"]);
  if (!versionOutput.includes(cliVersion))
    fail(`Railway CLI ${cliVersion} required, found '${versionOutput}'`);
  const results: Array<[string, string]> = [];
  results.push(await deployService(environment, "server", manifest.images.server, backupRef));
  const rest = await Promise.all(
    services
      .filter((name) => name !== "server")
      .map((name) => deployService(environment, name, manifest.images[name])),
  );
  results.push(...rest);
  console.log(`\n${environment} ${manifest.tag} (${manifest.sha})`);
  console.log("Service   Deployment");
  for (const [service, id] of results) console.log(`${service.padEnd(9)} ${id}`);
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
