import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { validateStartEnv } from "./validate-start-env.mjs";

const scriptPath = fileURLToPath(new URL("./validate-start-env.mjs", import.meta.url));

const baseProductionEnv = {
  NODE_ENV: "production",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.example.signature",
  MERIDIAN_API_ORIGIN: "https://server.meridian.example",
};

describe("validateStartEnv", () => {
  it("passes for production values", () => {
    const result = validateStartEnv(baseProductionEnv);

    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("rejects missing and development placeholder Supabase values", () => {
    const result = validateStartEnv({
      ...baseProductionEnv,
      SUPABASE_URL: "http://127.0.0.1:54421",
      SUPABASE_ANON_KEY: "dev-anon-key",
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "SUPABASE_URL" }),
        expect.objectContaining({ name: "SUPABASE_ANON_KEY" }),
      ]),
    );
  });

  it("rejects malformed origins in production", () => {
    const result = validateStartEnv({
      ...baseProductionEnv,
      MERIDIAN_API_ORIGIN: "notaurl",
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ name: "MERIDIAN_API_ORIGIN" }));
  });

  it("exits successfully without production validation outside production", () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: "development" },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Skipping production start env validation");
  });

  it("exits nonzero and prints grouped issues for invalid production env", () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "production",
        SUPABASE_URL: "http://127.0.0.1:54421",
        SUPABASE_ANON_KEY: "dev-anon-key",
        MERIDIAN_API_ORIGIN: "not-a-url",
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Production start blocked");
    expect(result.stderr).toContain("SUPABASE_URL");
    expect(result.stderr).toContain("MERIDIAN_API_ORIGIN");
  });
});
