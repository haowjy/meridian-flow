/** Dev mock-model script route core: absent mock is 404, invalid scripts are 400. */
import { describe, expect, it } from "vitest";
import { createMockScriptQueue } from "../domains/runtime/gateway/adapters/mock/script-queue.js";
import {
  clearMockModelScripts,
  enqueueMockModelScript,
  readMockModelScripts,
} from "./mock-model-script-route.js";

describe("mock-model script route core", () => {
  it("is 404 when no scriptable mock is composed", () => {
    expect(() => readMockModelScripts(null)).toThrow(expect.objectContaining({ statusCode: 404 }));
  });

  it("rejects invalid scripts with 400", () => {
    const queue = createMockScriptQueue();
    expect(() => enqueueMockModelScript(queue, { steps: [{}] })).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it("accepts a bare step array and reports queue state", () => {
    const queue = createMockScriptQueue();
    const state = enqueueMockModelScript(queue, [{ text: "a" }, { text: "b" }]);
    expect(state.scripts).toEqual([expect.objectContaining({ match: null, remaining: 2 })]);
    expect(clearMockModelScripts(queue).scripts).toEqual([]);
  });
});
