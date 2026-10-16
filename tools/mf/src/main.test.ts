/** ./mf top-level contract: usage errors and an unreachable stack. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT } from "./core/cli-error";
import { startWire, type Wire } from "./test-support/wire";
import { THREAD_ID } from "./test-support/wire-fixtures";

let wire: Wire;
beforeAll(async () => {
  wire = await startWire();
});
afterAll(() => wire.close());
const mf: Wire["mf"] = (argv, env) => wire.mf(argv, env);

describe("./mf", () => {
  it("prints a raw Markdown API response", async () => {
    const markdown = "# Chapter 1\nA beginning.\n";
    wire.fail("other", { status: 200, text: markdown });
    const result = await mf(["api", "GET", "/api/documents/test-document/download"]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout.trimEnd()).toBe(markdown.trimEnd());
    expect(result.stderr).toBe("");
  });

  it("rejects unknown flags and commands with exit 2", async () => {
    expect((await mf(["thread", "view", THREAD_ID, "--bogus"])).code).toBe(EXIT.usage);
    expect((await mf(["nope"])).code).toBe(EXIT.usage);
    // The follow joins from its own first read, so it takes no cursor.
    expect((await mf(["thread", "tail", THREAD_ID, "--until-idle", "--since", "0"])).code).toBe(
      EXIT.usage,
    );
  });

  it("reports an unreachable stack as exit 4 with a JSON error on stderr", async () => {
    const result = await mf(["thread", "list", "--json"], { MF_SERVER_URL: "http://127.0.0.1:9" });
    expect(result.code).toBe(EXIT.unavailable);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ code: "unavailable" });
  });
});
