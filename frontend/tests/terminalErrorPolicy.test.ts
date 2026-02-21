import { describe, expect, it } from "vitest";
import { AppError, ErrorType } from "@/core/lib/errors";
import {
  getTerminalErrorAction,
  shouldClearActiveSelection,
  shouldPruneLocalEntity,
} from "@/core/retrieval";

describe("terminalErrorPolicy", () => {
  it("prunes local document state on get-by-id 404", () => {
    const error = new AppError(ErrorType.NotFound, "missing");

    expect(shouldPruneLocalEntity("document:getById", error)).toBe(true);
    expect(getTerminalErrorAction("document:getById", error)).toBe(
      "prune_local_entity",
    );
  });

  it("clears active skill selection on get-by-id 404", () => {
    const error = new AppError(ErrorType.NotFound, "missing");

    expect(shouldClearActiveSelection("skill:getById", error)).toBe(true);
    expect(getTerminalErrorAction("skill:getById", error)).toBe(
      "clear_active_selection",
    );
  });

  it("clears active thread/project selection on get-by-id 404", () => {
    const error = new AppError(ErrorType.NotFound, "missing");

    expect(shouldClearActiveSelection("thread:getById", error)).toBe(true);
    expect(shouldClearActiveSelection("project:getById", error)).toBe(true);
  });

  it("keeps local state for non-mapped terminal errors", () => {
    const error = new AppError(ErrorType.Forbidden, "forbidden");

    expect(getTerminalErrorAction("document:getById", error)).toBe(
      "keep_local_state",
    );
  });
});
