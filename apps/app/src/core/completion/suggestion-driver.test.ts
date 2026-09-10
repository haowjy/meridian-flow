import { describe, expect, it, vi } from "vitest";
import { createDefaultSuggestionDriver, type SuggestionDriverFrame } from "./suggestion-driver";

type Row = { id: string };
const frame = (
  query: string,
  rows: readonly Row[],
  exit = vi.fn(),
): SuggestionDriverFrame<Row> => ({
  query,
  text: `%${query}`,
  triggerRange: { from: 1, to: query.length + 2 },
  candidates: rows,
  anchorRect: () => null,
  loading: false,
  requestExit: exit,
});

describe("default suggestion driver", () => {
  it("resets query focus, preserves refresh identity, falls back, and closes once", () => {
    const driver = createDefaultSuggestionDriver<Row, Row>({
      project: (input) => ({
        rows: input.candidates,
        rowId: (row) => row.id,
        label: "Rows",
        meta: null,
        choose: vi.fn(),
      }),
    });
    driver.start(frame("", [{ id: "a" }, { id: "b" }]));
    driver.menu.setActiveId("b");
    driver.update(frame("", [{ id: "a" }, { id: "b" }, { id: "c" }]));
    expect(driver.menu.snapshot().activeId).toBe("b");
    driver.update(frame("b", [{ id: "b" }, { id: "c" }]));
    expect(driver.menu.snapshot().activeId).toBe("b");
    driver.menu.setActiveId("c");
    driver.update(frame("b", [{ id: "b" }]));
    expect(driver.menu.snapshot().activeId).toBe("b");
    driver.exit();
    driver.exit();
    expect(driver.menu.snapshot().open).toBe(false);
  });

  it("requests transport exit when projection disappears", () => {
    const requestExit = vi.fn();
    const driver = createDefaultSuggestionDriver<Row, Row>({ project: () => null });
    driver.start(frame("", [], requestExit));
    expect(requestExit).toHaveBeenCalledOnce();
  });
});
