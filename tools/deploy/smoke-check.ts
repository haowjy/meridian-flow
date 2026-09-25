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
const workosDomain = options.get("--workos-domain");
if (!base || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)
  throw new Error(
    "Usage: node tools/deploy/smoke-check.ts <baseUrl> [--expect-version X] [--expect-release SHA] [--timeout S] [--www-url URL] [--workos-domain HOST]",
  );
const origin = new URL(base);
const appOrigin = new URL(origin.origin);
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
function releaseHeaders(response: Response): { valid: boolean; detail: string } {
  const version = response.headers.get("x-meridian-version") ?? "";
  const release = response.headers.get("x-meridian-release") ?? "";
  const valid = Boolean(
    version &&
      release &&
      (!expectedVersion || version === expectedVersion) &&
      (!expectedRelease || release === expectedRelease),
  );
  return { valid, detail: `version=${version || "absent"}, release=${release || "absent"}` };
}
function loginRedirect(location: string): { valid: boolean; detail: string } {
  if (!location) return { valid: false, detail: "location absent" };
  let target: URL;
  try {
    target = new URL(location, appOrigin);
  } catch {
    return { valid: false, detail: `invalid location=${location}` };
  }
  const localLogin =
    target.origin === appOrigin.origin &&
    (target.pathname === "/login" || target.pathname.startsWith("/login/"));
  const isWorkosHost =
    target.hostname === "api.workos.com" ||
    (workosDomain !== undefined &&
      target.hostname ===
        workosDomain
          .replace(/^https?:\/\//, "")
          .split("/")[0]
          .toLowerCase());
  const clientId = target.searchParams.get("client_id")?.trim() ?? "";
  const redirectUri = target.searchParams.get("redirect_uri") ?? "";
  const expectedRedirectUri = new URL("/api/auth/callback", appOrigin).toString();
  const workosLogin =
    target.protocol === "https:" &&
    isWorkosHost &&
    target.pathname === "/user_management/authorize" &&
    Boolean(clientId) &&
    redirectUri === expectedRedirectUri;
  return {
    valid: localLogin || workosLogin,
    detail: localLogin
      ? `same-origin ${target.pathname}`
      : workosLogin
        ? `WorkOS authorize; client_id present, redirect_uri matches ${expectedRedirectUri}`
        : `unexpected redirect=${target.toString()}`,
  };
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
  checks.push(
    await checked("app / redirect", async () => {
      const response = await request(appOrigin.toString());
      const location = response.headers.get("location") ?? "";
      const redirect = loginRedirect(location);
      const headers = releaseHeaders(response);
      const good =
        response.status >= 300 && response.status < 400 && redirect.valid && headers.valid;
      return good
        ? `PASS (HTTP ${response.status}; ${redirect.detail}; ${headers.detail})`
        : `FAIL (HTTP ${response.status}; ${redirect.detail}; ${headers.detail})`;
    }),
  );
  checks.push(
    await checked("app /login", async () => {
      const response = await request(new URL("/login", appOrigin).toString());
      const body = await response.text();
      const hasTitle = /<title>\s*Meridian\s*<\/title>/i.test(body);
      const headers = releaseHeaders(response);
      const good = response.status === 200 && hasTitle && headers.valid;
      return good
        ? `PASS (${headers.detail})`
        : `FAIL (HTTP ${response.status}, Meridian title=${hasTitle}, ${headers.detail})`;
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
