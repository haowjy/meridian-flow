import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import type { ExpectedServiceName } from "./portless-routes";

export type DevServiceOrigins = Partial<Record<ExpectedServiceName, string>>;

type ReadinessHttpClient = (url: string) => Promise<{ status: number }>;

interface ReadinessTarget {
  service: ExpectedServiceName;
  url: string;
  acceptStatus(status: number): boolean;
}

export interface DevReadinessResult {
  ok: boolean;
  errors: string[];
}

interface WaitForDevReadinessOptions {
  origins: DevServiceOrigins;
  timeoutMs: number;
  httpClient?: ReadinessHttpClient;
  sleepMs?: number;
}

const PORTLESS_CA_PATH = path.join(os.homedir(), ".portless", "ca.pem");

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function portlessCa(): string[] | undefined {
  if (!fs.existsSync(PORTLESS_CA_PATH)) return undefined;
  return [...tls.rootCertificates, fs.readFileSync(PORTLESS_CA_PATH, "utf8")];
}

function requestStatus(url: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = (parsed.protocol === "http:" ? http : https).request(
      parsed,
      {
        method: "GET",
        timeout: 2_000,
        ...(parsed.protocol === "https:" ? { ca: portlessCa() } : {}),
      },
      (response) => {
        response.resume();
        resolve({ status: response.statusCode ?? 0 });
      },
    );

    request.on("timeout", () => request.destroy(new Error("request timed out")));
    request.on("error", reject);
    request.end();
  });
}

function targetsForOrigins(origins: DevServiceOrigins): ReadinessTarget[] {
  const targets: ReadinessTarget[] = [];

  if (origins.server) {
    targets.push({
      service: "server",
      url: new URL("/readyz", origins.server).toString(),
      acceptStatus: (status) => status === 200,
    });
  }

  if (origins.app) {
    targets.push({
      service: "app",
      url: origins.app,
      acceptStatus: (status) => status < 500,
    });
  }

  return targets;
}

async function probeTarget(
  target: ReadinessTarget,
  httpClient: ReadinessHttpClient,
): Promise<string | null> {
  try {
    const response = await httpClient(target.url);
    if (target.acceptStatus(response.status)) return null;
    return `${target.service} ${target.url} returned HTTP ${response.status}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `${target.service} ${target.url} unreachable: ${message}`;
  }
}

export async function checkDevReadiness({
  origins,
  httpClient = requestStatus,
}: Pick<WaitForDevReadinessOptions, "origins" | "httpClient">): Promise<DevReadinessResult> {
  const targets = targetsForOrigins(origins);
  const missing = ["server", "app"].filter((service) => !origins[service as ExpectedServiceName]);
  const errors = missing.map((service) => `missing ${service} route URL for readiness check`);

  for (const target of targets) {
    const error = await probeTarget(target, httpClient);
    if (error) errors.push(error);
  }

  return { ok: errors.length === 0, errors };
}

export async function waitForDevReadiness({
  origins,
  timeoutMs,
  httpClient = requestStatus,
  sleepMs = 500,
}: WaitForDevReadinessOptions): Promise<DevReadinessResult> {
  const deadline = Date.now() + timeoutMs;
  let result = await checkDevReadiness({ origins, httpClient });

  while (!result.ok && Date.now() < deadline) {
    sleep(sleepMs);
    result = await checkDevReadiness({ origins, httpClient });
  }

  return result;
}
