import { describe, expect, it } from "vitest";
import { checkDevReadiness, waitForDevReadiness } from "../dev-readiness";

function response(status: number): { status: number } {
  return { status };
}

describe("dev readiness", () => {
  it("requires server /readyz and the app origin before accepting startup", async () => {
    const calls: string[] = [];
    const httpClient = async (url: string) => {
      calls.push(String(url));
      if (String(url).endsWith("/readyz")) return response(200);
      return response(302);
    };

    await expect(
      checkDevReadiness({
        origins: {
          server: "https://worktree.server.meridian.localhost",
          app: "https://worktree.app.meridian.localhost",
        },
        httpClient,
      }),
    ).resolves.toEqual({ ok: true, errors: [] });
    expect(calls).toEqual([
      "https://worktree.server.meridian.localhost/readyz",
      "https://worktree.app.meridian.localhost",
    ]);
  });

  it("keeps polling until both readiness targets pass", async () => {
    let appAttempts = 0;
    const httpClient = async (url: string) => {
      if (String(url).endsWith("/readyz")) return response(200);
      appAttempts += 1;
      return response(appAttempts === 1 ? 503 : 200);
    };

    await expect(
      waitForDevReadiness({
        origins: {
          server: "https://worktree.server.meridian.localhost",
          app: "https://worktree.app.meridian.localhost",
        },
        timeoutMs: 1_000,
        sleepMs: 1,
        httpClient,
      }),
    ).resolves.toEqual({ ok: true, errors: [] });
    expect(appAttempts).toBe(2);
  });

  it("reports missing route origins as startup failures", async () => {
    await expect(
      checkDevReadiness({
        origins: { app: "https://app.meridian.localhost" },
        httpClient: async () => response(200),
      }),
    ).resolves.toMatchObject({
      ok: false,
      errors: ["missing server route URL for readiness check"],
    });
  });
});
