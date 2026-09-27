/** ./mf top-level contract: grouped help, usage errors, unreachable stack, auth, large output. */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT } from "./core/cli-error";
import { COMMANDS, GROUPS } from "./main";
import { type FakeStack, startFakeStack, THREAD_ID } from "./test-support/fake-stack";

let stack: FakeStack;
beforeAll(async () => {
  stack = await startFakeStack();
});
afterAll(() => stack.close());
const mf: FakeStack["mf"] = (argv, env) => stack.mf(argv, env);

describe("./mf", () => {
  it("lists every command with the route it wraps", async () => {
    const { code, stdout } = await mf([]);
    expect(code).toBe(EXIT.ok);
    for (const spec of COMMANDS) {
      expect(stdout).toContain(`./mf ${spec.path.join(" ")}`);
      expect(stdout).toContain(spec.route);
    }
  });

  it("rejects unknown flags and commands with exit 2", async () => {
    expect((await mf(["thread", "view", THREAD_ID, "--bogus"])).code).toBe(EXIT.usage);
    expect((await mf(["nope"])).code).toBe(EXIT.usage);
  });

  it("reports an unreachable stack as exit 4 with a JSON error on stderr", async () => {
    const result = await mf(["thread", "list", "--json"], { MF_SERVER_URL: "http://127.0.0.1:9" });
    expect(result.code).toBe(EXIT.unavailable);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ code: "unavailable" });
  });

  it("maps 401 to exit 4", async () => {
    expect((await mf(["thread", "list"], { MF_COOKIE: "wrong" })).code).toBe(EXIT.unavailable);
  });

  it("writes large JSON results whole", async () => {
    const result = await mf(["api", "GET", "/api/big", "--json"]);
    expect(result.code).toBe(EXIT.ok);
    expect(JSON.parse(result.stdout).blob).toHaveLength(300_000);
  });

  it("groups help by command group and prints one group's help", async () => {
    const all = await mf([]);
    for (const group of GROUPS) expect(all.stdout).toContain(`${group.name}: ${group.summary}`);
    const thread = await mf(["thread"]);
    expect(thread.code).toBe(EXIT.ok);
    expect(thread.stdout).toContain("thread: ");
    expect(thread.stdout).not.toContain("doc: ");
  });

  it("boots through the real ./mf shim (catches load-order bugs vitest's ESM loader hides)", () => {
    const shim = path.resolve(__dirname, "../../../mf");
    const help = execFileSync(shim, [], { encoding: "utf8", timeout: 30_000 });
    for (const group of GROUPS) expect(help).toContain(`${group.name}: ${group.summary}`);
  });
});
