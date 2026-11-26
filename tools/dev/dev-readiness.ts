import http from "node:http";

export interface DevReadinessResult {
  ok: boolean;
  errors: string[];
}

function requestStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: "GET", timeout: 2_000 }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("timeout", () => request.destroy(new Error("request timed out")));
    request.on("error", reject);
    request.end();
  });
}

async function probe(
  service: string,
  url: string,
  accept: (status: number) => boolean,
): Promise<string | null> {
  try {
    const status = await requestStatus(url);
    return accept(status) ? null : `${service} ${url} returned HTTP ${status}`;
  } catch (error) {
    return `${service} ${url} unreachable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function checkDevReadiness(origins: {
  app: string;
  server: string;
}): Promise<DevReadinessResult> {
  const errors = (
    await Promise.all([
      probe("server", new URL("/readyz", origins.server).toString(), (status) => status === 200),
      probe("app", origins.app, (status) => status === 200 || (status >= 300 && status < 400)),
    ])
  ).filter((error): error is string => error !== null);
  return { ok: errors.length === 0, errors };
}
