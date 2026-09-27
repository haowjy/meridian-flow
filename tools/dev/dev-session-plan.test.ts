/** Dev session command: local dev opts the server into debug paths unless the env says otherwise. */
import { describe, expect, it } from "vitest";
import { createDevSessionCommand } from "./dev-session-plan";

function command(env: NodeJS.ProcessEnv) {
  return createDevSessionCommand({ mode: "local", sharedPorts: [], env });
}

describe("createDevSessionCommand APP_DEBUG", () => {
  it("exports APP_DEBUG=1 by default", () => {
    expect(command({}).executable).toContain("export APP_DEBUG='1'");
  });

  it("keeps an explicit APP_DEBUG from the environment", () => {
    const { executable } = command({ APP_DEBUG: "0" });
    expect(executable).toContain("export APP_DEBUG='0'");
    expect(executable).not.toContain("export APP_DEBUG='1'");
  });
});
