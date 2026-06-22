import { describe, expect, it } from "vitest";
import { resolveAppEnvPassthroughKeys } from "./dev-app-env-passthrough";

describe("dev-tmux app env passthrough", () => {
  it("passes provider API keys when MODEL_PROVIDER is unset", () => {
    const env = {
      DEEPSEEK_API_KEY: "sk-real",
      DATABASE_URL: "postgresql://localhost/db",
    };

    expect(resolveAppEnvPassthroughKeys(env)).toEqual(["DATABASE_URL", "DEEPSEEK_API_KEY"]);
  });

  it("passes MODEL_PROVIDER=mock alongside provider API keys", () => {
    const env = {
      MODEL_PROVIDER: "mock",
      DEEPSEEK_API_KEY: "sk-real",
    };

    expect(resolveAppEnvPassthroughKeys(env)).toEqual(["MODEL_PROVIDER", "DEEPSEEK_API_KEY"]);
  });

  it("passes provider API keys when MODEL_PROVIDER is a legacy no-op value", () => {
    const env = {
      MODEL_PROVIDER: "auto",
      DEEPSEEK_API_KEY: "sk-real",
      OPENAI_API_KEY: "sk-openai",
      OPENROUTER_API_KEY: "sk-openrouter",
    };

    expect(resolveAppEnvPassthroughKeys(env)).toEqual([
      "MODEL_PROVIDER",
      "OPENAI_API_KEY",
      "DEEPSEEK_API_KEY",
      "OPENROUTER_API_KEY",
    ]);
  });
});
