import { describe, expect, it } from "vitest";
import type { CreateThreadInput } from "../ports/repositories.js";
import {
  type NormalizedThreadCreate,
  normalizeThreadCreate,
  ThreadLifecycleNotSupportedError,
} from "./thread-create.js";

const baseInput = {
  userId: "user-1",
  projectId: "project-1",
} satisfies CreateThreadInput;

const expectedRoot: NormalizedThreadCreate = {
  kind: "primary",
  title: "",
  systemPrompt: null,
  currentAgent: null,
  parentThreadId: null,
  spawnStatus: null,
  spawnDepth: 0,
};

describe("normalizeThreadCreate", () => {
  it("accepts minimal root create", () => {
    expect(normalizeThreadCreate(baseInput)).toEqual(expectedRoot);
  });

  it("accepts root create with explicit kind=primary", () => {
    expect(normalizeThreadCreate({ ...baseInput, kind: "primary" })).toEqual(expectedRoot);
  });

  it("normalizes title and system prompt on root create", () => {
    expect(
      normalizeThreadCreate({
        ...baseInput,
        title: "My thread",
        systemPrompt: "You are helpful.",
      }),
    ).toEqual({
      ...expectedRoot,
      title: "My thread",
      systemPrompt: "You are helpful.",
    });
  });

  it("rejects subagent kind", () => {
    expect(() =>
      normalizeThreadCreate({ ...baseInput, kind: "subagent", parentThreadId: "parent-1" }),
    ).toThrow(ThreadLifecycleNotSupportedError);
    expect(() =>
      normalizeThreadCreate({ ...baseInput, kind: "subagent", parentThreadId: "parent-1" }),
    ).toThrow(/kind "subagent" is not supported/);
  });

  it("rejects parentThreadId", () => {
    expect(() => normalizeThreadCreate({ ...baseInput, parentThreadId: "parent-1" })).toThrow(
      ThreadLifecycleNotSupportedError,
    );
    expect(() => normalizeThreadCreate({ ...baseInput, parentThreadId: "parent-1" })).toThrow(
      /parentThreadId is not supported/,
    );
  });

  it("rejects spawnStatus", () => {
    expect(() => normalizeThreadCreate({ ...baseInput, spawnStatus: "running" })).toThrow(
      ThreadLifecycleNotSupportedError,
    );
    expect(() => normalizeThreadCreate({ ...baseInput, spawnStatus: "running" })).toThrow(
      /spawnStatus is not supported/,
    );
  });

  it("rejects spawnDepth > 0", () => {
    expect(() => normalizeThreadCreate({ ...baseInput, spawnDepth: 1 })).toThrow(
      ThreadLifecycleNotSupportedError,
    );
    expect(() => normalizeThreadCreate({ ...baseInput, spawnDepth: 1 })).toThrow(
      /spawnDepth > 0 is not supported/,
    );
  });

  it("accepts explicit spawnDepth 0", () => {
    expect(normalizeThreadCreate({ ...baseInput, spawnDepth: 0 })).toEqual(expectedRoot);
  });
});
