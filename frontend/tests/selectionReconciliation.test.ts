import { describe, expect, it, vi } from "vitest";
import { reconcileSelectionIfMissing } from "@/core/retrieval";

describe("reconcileSelectionIfMissing", () => {
  it("clears stale selection and returns true", () => {
    const clearSelection = vi.fn();
    const onStaleSelection = vi.fn();

    const didClear = reconcileSelectionIfMissing({
      items: [{ id: "a" }, { id: "b" }],
      activeId: "c",
      getId: (item) => item.id,
      clearSelection,
      onStaleSelection,
    });

    expect(didClear).toBe(true);
    expect(onStaleSelection).toHaveBeenCalledWith("c");
    expect(clearSelection).toHaveBeenCalledTimes(1);
  });

  it("keeps valid selection and returns false", () => {
    const clearSelection = vi.fn();

    const didClear = reconcileSelectionIfMissing({
      items: [{ id: "a" }, { id: "b" }],
      activeId: "a",
      getId: (item) => item.id,
      clearSelection,
    });

    expect(didClear).toBe(false);
    expect(clearSelection).not.toHaveBeenCalled();
  });

  it("returns false when there is no active selection", () => {
    const clearSelection = vi.fn();

    const didClear = reconcileSelectionIfMissing({
      items: [{ id: "a" }],
      activeId: null,
      getId: (item) => item.id,
      clearSelection,
    });

    expect(didClear).toBe(false);
    expect(clearSelection).not.toHaveBeenCalled();
  });
});
