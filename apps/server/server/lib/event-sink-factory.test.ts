import { afterEach, describe, expect, it } from "vitest";
import { createEventSinkFromEnv } from "./event-sink-factory.js";

const ENV_KEYS = ["EVENT_PROVIDER", "LOG_DIR", "LOG_RETENTION_DAYS"] as const;

const originalEnv = new Map<(typeof ENV_KEYS)[number], string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const key of ENV_KEYS) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("createEventSinkFromEnv", () => {
  it("ignores LOG_RETENTION_DAYS when LOG_DIR is unset", () => {
    setEnv({ EVENT_PROVIDER: "local", LOG_RETENTION_DAYS: "not-a-number" });

    expect(() => createEventSinkFromEnv()).not.toThrow();
  });

  it("validates LOG_RETENTION_DAYS when JSONL mirroring is enabled", () => {
    setEnv({ EVENT_PROVIDER: "local", LOG_DIR: "/tmp/meridian-logs", LOG_RETENTION_DAYS: "0" });

    expect(() => createEventSinkFromEnv()).toThrow("LOG_RETENTION_DAYS must be a positive integer");
  });
});
