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
});
