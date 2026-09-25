/** Runtime smoke checks for an already deployed Meridian release. Ingress must proxy /healthz and /readyz to server. */
export {};

type Result = { name: string; result: string };
const args = process.argv.slice(2);
const base = args.shift();
const options = new Map<string, string>();
for (let i = 0; i < args.length; i += 1) {
  const key = args[i];
  if (!key.startsWith("--") || !args[i + 1]) throw new Error(`Invalid option near ${key}`);
  options.set(key, args[++i]);
}
const timeoutSeconds = Number(options.get("--timeout") ?? 120);
const expectedVersion = options.get("--expect-version");
const expectedRelease = options.get("--expect-release");
if (!base || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)
  throw new Error(
    "Usage: node tools/deploy/smoke-check.ts <baseUrl> [--expect-version X] [--expect-release SHA] [--timeout S] [--www-url URL]",
  );
const origin = new URL(base);
const deadline = Date.now() + timeoutSeconds * 1000;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function request(url: string) {
  return fetch(url, { signal: AbortSignal.timeout(3000), redirect: "manual" });
}
async function checked(name: string, fn: () => Promise<string>): Promise<Result> {
  try {
    return { name, result: await fn() };
  } catch (error) {
    return { name, result: `FAIL (${error instanceof Error ? error.message : error})` };
  }
}
async function runChecks(): Promise<Result[]> {
  const checks: Result[] = [];
  checks.push(
    await checked("server /healthz", async () => {
      const response = await request(new URL("/healthz", origin).toString());
      const data = (await response.json()) as {
        status?: string;
        service?: string;
        version?: string;
        release?: string;
      };
      const good =
        response.status === 200 &&
        data.status === "ok" &&
        data.service === "api" &&
        (!expectedVersion || data.version === expectedVersion) &&
        (!expectedRelease || data.release === expectedRelease);
      return good
        ? `PASS (${data.version ?? "version absent"}, ${data.release ?? "release absent"})`
        : `FAIL (HTTP ${response.status}, service=${data.service}, version=${data.version}, release=${data.release})`;
    }),
  );
  checks.push(
    await checked("server /readyz", async () => {
      const response = await request(new URL("/readyz", origin).toString());
      const body = (await response.json()) as { ready?: boolean };
      return response.status === 200 && body.ready === true
        ? "PASS"
        : `FAIL (HTTP ${response.status})`;
    }),
  );
  let loginLocation = "/login";
  checks.push(
    await checked("app / redirect", async () => {
      const response = await request(origin.toString());
      const location = response.headers.get("location") ?? "";
      loginLocation = location || loginLocation;
      return response.status >= 300 && response.status < 400 && /\/login(?:\?|$)/.test(location)
        ? `PASS (${response.status} ${location})`
        : `FAIL (HTTP ${response.status}, location=${location || "absent"})`;
    }),
  );
  checks.push(
    await checked("app /login", async () => {
      const response = await request(new URL(loginLocation, origin).toString());
      const body = await response.text();
      const hasTitle = /<title>\s*Meridian\s*<\/title>/i.test(body);
      const matches =
        (!expectedVersion || response.headers.get("x-meridian-version") === expectedVersion) &&
        (!expectedRelease || response.headers.get("x-meridian-release") === expectedRelease);
      const good = response.status === 200 && hasTitle && matches;
      return good
        ? "PASS"
        : `FAIL (HTTP ${response.status}, Meridian title=${hasTitle}, version=${response.headers.get("x-meridian-version")}, release=${response.headers.get("x-meridian-release")})`;
    }),
  );
  checks.push(
    await checked("websocket /ws/yjs", async () => {
      const wsUrl = new URL("/ws/yjs", origin);
      wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(wsUrl);
      return new Promise<string>((resolve) => {
        let opened = false;
        const timer = setTimeout(() => {
          ws.close();
          resolve("FAIL (no auth close within 3s)");
        }, 3000);
        const finish = (result: string) => {
          clearTimeout(timer);
          resolve(result);
        };
        ws.addEventListener(
          "open",
          () => {
            opened = true;
          },
          { once: true },
        );
        ws.addEventListener(
          "close",
          (event) => {
            finish(
              opened && event.code === 4401 && event.reason === "auth_failed"
                ? "PASS (upgrade opened; closed 4401 auth_failed)"
                : `FAIL (opened=${opened}, close=${event.code} ${event.reason || "no reason"})`,
            );
          },
          { once: true },
        );
        ws.addEventListener(
          "error",
          () =>
            finish(`FAIL (${opened ? "websocket error after open" : "upgrade error before open"})`),
          { once: true },
        );
      });
    }),
  );
  const www = options.get("--www-url");
  if (www)
    checks.push(
      await checked("www /", async () => {
        const response = await request(new URL("/", www).toString());
        return response.status === 200 ? "PASS" : `FAIL (HTTP ${response.status})`;
      }),
    );
  return checks;
}
let checks: Result[] = [];
let passed = false;
do {
  checks = await runChecks();
  passed = checks.every((check) => check.result.startsWith("PASS"));
  if (!passed && Date.now() < deadline) await pause(1000);
} while (!passed && Date.now() < deadline);
console.log("Check                 Result");
for (const check of checks) console.log(`${check.name.padEnd(22)} ${check.result}`);
if (!passed) {
  console.error(`Smoke checks failed after ${timeoutSeconds}s`);
  process.exitCode = 1;
}
