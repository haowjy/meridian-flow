import { describe, expect, it } from "vitest";
import { applyModeEnv, parseDevCliOptions } from "./dev-mode";

describe("parseDevCliOptions", () => {
  it("defaults to tailscale mode", () => {
    expect(parseDevCliOptions({ argv: [], env: {} as NodeJS.ProcessEnv }).mode).toBe("tailscale");
  });

  it("opts out of tailscale with --no-tailscale", () => {
    const parsed = parseDevCliOptions({ argv: ["--no-tailscale"], env: {} as NodeJS.ProcessEnv });
    expect(parsed.mode).toBe("local");
    expect(parsed.explicitModeFlag).toBe(true);
  });

  it("opts out of tailscale with PORTLESS_TAILSCALE=0", () => {
    const parsed = parseDevCliOptions({
      argv: [],
      env: { PORTLESS_TAILSCALE: "0" } as NodeJS.ProcessEnv,
    });
    expect(parsed.mode).toBe("local");
  });

  it("parses tailscale and restart flags", () => {
    const parsed = parseDevCliOptions({ argv: ["--tailscale", "--restart"] });
    expect(parsed.mode).toBe("tailscale");
    expect(parsed.restart).toBe(true);
  });

  it("makes funnel win over --no-tailscale", () => {
    const parsed = parseDevCliOptions({
      argv: ["--no-tailscale", "--funnel"],
      env: {} as NodeJS.ProcessEnv,
    });
    expect(parsed.mode).toBe("funnel");
  });

  it("supports dry-run and preserve-mode flags", () => {
    const parsed = parseDevCliOptions({ argv: ["--print", "--preserve-mode"] });
    expect(parsed.print).toBe(true);
    expect(parsed.preserveModeOnRestart).toBe(true);
  });

  it("reads sharing mode from environment", () => {
    const parsed = parseDevCliOptions({
      argv: [],
      env: { PORTLESS_TAILSCALE: "1" } as NodeJS.ProcessEnv,
    });

    expect(parsed.mode).toBe("tailscale");
  });

  it("applies local/tailscale/funnel env without leaking the previous sharing mode", () => {
    const originalTailscale = process.env.PORTLESS_TAILSCALE;
    const originalFunnel = process.env.PORTLESS_FUNNEL;
    try {
      process.env.PORTLESS_TAILSCALE = "1";
      process.env.PORTLESS_FUNNEL = "1";
      applyModeEnv("local");
      expect(process.env.PORTLESS_TAILSCALE).toBeUndefined();
      expect(process.env.PORTLESS_FUNNEL).toBeUndefined();

      applyModeEnv("tailscale");
      expect(process.env.PORTLESS_TAILSCALE).toBe("1");
      expect(process.env.PORTLESS_FUNNEL).toBeUndefined();

      applyModeEnv("funnel");
      expect(process.env.PORTLESS_TAILSCALE).toBe("1");
      expect(process.env.PORTLESS_FUNNEL).toBe("1");
    } finally {
      if (originalTailscale === undefined) {
        delete process.env.PORTLESS_TAILSCALE;
      } else {
        process.env.PORTLESS_TAILSCALE = originalTailscale;
      }
      if (originalFunnel === undefined) {
        delete process.env.PORTLESS_FUNNEL;
      } else {
        process.env.PORTLESS_FUNNEL = originalFunnel;
      }
    }
  });
});
