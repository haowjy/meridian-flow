import { describe, expect, it } from "vitest";
import { createDevSessionCommand, redactEnvValue } from "../dev-session-plan";

const sharedPorts = [
  {
    service: "app" as const,
    appBackendPort: 43100,
    externalHttpsPort: 47100,
    externalMode: "serve" as const,
  },
];

describe("dev session command planning", () => {
  it("exports canonical worktree API and database env into the executable command", () => {
    const command = createDevSessionCommand({
      mode: "tailscale",
      sharedPorts,
      worktreePrefix: "dev-tooling-hardening",
      env: {
        DATABASE_URL:
          "postgresql://postgres:postgres@127.0.0.1:54422/meridian_dev-tooling-hardening",
        WORKOS_API_KEY: "sk_test_secret",
        PORTLESS_STATE_DIR: "/tmp/portless-state",
      },
    });

    expect(command.internalApiOrigin).toBe(
      "https://dev-tooling-hardening.server.meridian.localhost",
    );
    expect(command.executable).toContain(
      "export DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:54422/meridian_dev-tooling-hardening'",
    );
    expect(command.executable).toContain(
      "export MERIDIAN_API_ORIGIN='https://dev-tooling-hardening.server.meridian.localhost'",
    );
    expect(command.executable).toContain("--app-port 43100");
  });

  it("keeps display commands safe while preserving useful DB identity", () => {
    const command = createDevSessionCommand({
      mode: "tailscale",
      sharedPorts,
      worktreePrefix: "dev-tooling-hardening",
      env: {
        DATABASE_URL:
          "postgresql://postgres:postgres@127.0.0.1:54422/meridian_dev-tooling-hardening",
        WORKOS_API_KEY: "sk_test_secret",
        WORKOS_DEV_LOGIN_PASSWORD: "dev-password",
      },
    });

    expect(command.display).toContain(
      "DATABASE_URL='<postgres:127.0.0.1:54422/meridian_dev-tooling-hardening>'",
    );
    expect(command.display).toContain("WORKOS_API_KEY='<redacted>'");
    expect(command.display).toContain("WORKOS_DEV_LOGIN_PASSWORD='<redacted>'");
    expect(command.display).not.toContain("postgres:postgres");
    expect(command.display).not.toContain("sk_test_secret");
    expect(command.display).not.toContain("dev-password");
  });

  it("redacts malformed database URLs without echoing the raw value", () => {
    expect(redactEnvValue("DATABASE_URL", "not a url with secret")).toBe("<postgres:redacted>");
  });
});
