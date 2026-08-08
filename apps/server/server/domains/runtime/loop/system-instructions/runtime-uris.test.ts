/** Model URI guidance stays aligned with tool schemas and Work-qualified scratch paths. */
import { describe, expect, it } from "vitest";
import { RUNTIME_URI_SYSTEM_INSTRUCTION } from "./runtime-uris.js";

describe("RUNTIME_URI_SYSTEM_INSTRUCTION", () => {
  it("documents Work qualification and delegates write commands to the schema", () => {
    expect(RUNTIME_URI_SYSTEM_INSTRUCTION).toContain("`scratch://@<slug>/...`");
    expect(RUNTIME_URI_SYSTEM_INSTRUCTION).toContain("cannot begin with `@`");
    expect(RUNTIME_URI_SYSTEM_INSTRUCTION).toContain("See the `write` tool schema");
    expect(RUNTIME_URI_SYSTEM_INSTRUCTION).not.toContain("command=create");
    expect(RUNTIME_URI_SYSTEM_INSTRUCTION).not.toContain("work {command");
  });
});
