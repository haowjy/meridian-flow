import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  buildProviderApiKeyGuardShell,
  resolveAppEnvPassthroughKeys,
  shouldPassthroughProviderApiKeys,
} from "./dev-app-env-passthrough";

describe("dev-tmux app env passthrough", () => {
  it("does not pass provider API keys when MODEL_PROVIDER is unset", () => {
    const env = {
      DEEPSEEK_API_KEY: "sk-real",
      DATABASE_URL: "postgresql://localhost/db",
    };

    expect(shouldPassthroughProviderApiKeys(env)).toBe(false);
    expect(resolveAppEnvPassthroughKeys(env)).toEqual(["DATABASE_URL"]);
  });

  it("passes MODEL_PROVIDER=mock without provider API keys", () => {
    const env = {
      MODEL_PROVIDER: "mock",
      DEEPSEEK_API_KEY: "sk-real",
    };

    expect(shouldPassthroughProviderApiKeys(env)).toBe(false);
    expect(resolveAppEnvPassthroughKeys(env)).toEqual(["MODEL_PROVIDER"]);
  });

  it("passes provider API keys when MODEL_PROVIDER explicitly opts into real models", () => {
    const env = {
      MODEL_PROVIDER: "auto",
      DEEPSEEK_API_KEY: "sk-real",
      OPENAI_API_KEY: "sk-openai",
    };

    expect(shouldPassthroughProviderApiKeys(env)).toBe(true);
    expect(resolveAppEnvPassthroughKeys(env)).toEqual([
      "MODEL_PROVIDER",
      "OPENAI_API_KEY",
      "DEEPSEEK_API_KEY",
    ]);
  });

  it("builds a shell guard that clears keys unless MODEL_PROVIDER opts into real providers", () => {
    const modelProviderExpansion = ["$", "{MODEL_PROVIDER:-}"].join("");
    expect(buildProviderApiKeyGuardShell()).toBe(
      `; case "${modelProviderExpansion}" in anthropic|openai|auto) ;; *) unset ANTHROPIC_API_KEY OPENAI_API_KEY DEEPSEEK_API_KEY ;; esac`,
    );
  });

  it("shell guard clears inherited provider keys when MODEL_PROVIDER is unset", () => {
    const guard = buildProviderApiKeyGuardShell();
    const script = [
      "export DEEPSEEK_API_KEY=sk-inherited",
      "export OPENAI_API_KEY=sk-openai",
      guard.slice(2),
      "printenv DEEPSEEK_API_KEY 2>/dev/null || echo cleared",
    ].join("; ");
    const output = execFileSync("bash", ["-lc", script], { encoding: "utf8" });

    expect(output.trim()).toBe("cleared");
  });

  it("shell guard clears provider keys loaded from .env when MODEL_PROVIDER=mock", () => {
    const guard = buildProviderApiKeyGuardShell();
    const script = [
      "export MODEL_PROVIDER=mock",
      "export DEEPSEEK_API_KEY=sk-dotenv",
      guard.slice(2),
      "printenv DEEPSEEK_API_KEY 2>/dev/null || echo cleared",
    ].join("; ");
    const output = execFileSync("bash", ["-lc", script], { encoding: "utf8" });

    expect(output.trim()).toBe("cleared");
  });

  it("shell guard keeps provider keys when MODEL_PROVIDER=auto", () => {
    const guard = buildProviderApiKeyGuardShell();
    const script = [
      "export MODEL_PROVIDER=auto",
      "export DEEPSEEK_API_KEY=sk-real",
      guard.slice(2),
      "printenv DEEPSEEK_API_KEY",
    ].join("; ");
    const output = execFileSync("bash", ["-lc", script], { encoding: "utf8" });

    expect(output.trim()).toBe("sk-real");
  });
});
