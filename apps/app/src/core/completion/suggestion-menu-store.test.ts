import { describe, expect, it, vi } from "vitest";

import {
  createInternalSuggestionLifecycle,
  type InternalSuggestionSession,
} from "./suggestion-menu-store";

type Row = { id: string; blocked?: boolean; label?: string };
const ROWS: Row[] = [
  { id: "heading", blocked: true },
  { id: "quote" },
  { id: "table", blocked: true },
  { id: "code" },
];
const choosableRow = (item: Row) => item.blocked !== true;

function session(
  items: readonly Row[],
  overrides: Partial<InternalSuggestionSession<Row>> = {},
): InternalSuggestionSession<Row> {
  return {
    items,
    rowId: (row) => row.id,
    query: "",
    anchorRect: () => null,
    label: "Insert block",
    meta: null,
    choose: vi.fn(),
    dismiss: vi.fn(),
    ...overrides,
  };
}

function nextGeneration(
  lifecycle: ReturnType<typeof createInternalSuggestionLifecycle<Row>>["lifecycle"],
  sessionId: string,
) {
  const generation = lifecycle.nextGeneration(sessionId);
  if (!generation) throw new Error("expected an active suggestion session");
  return generation;
}

describe("suggestion lifecycle", () => {
  it("publishes open, accepted update, and close through one callback boundary", () => {
    const callbacks = { open: vi.fn(), update: vi.fn(), close: vi.fn() };
    const { menu, lifecycle } = createInternalSuggestionLifecycle<Row>(callbacks);
    const identity = lifecycle.open(session(ROWS));
    const generation = nextGeneration(lifecycle, identity.sessionId);

    expect(lifecycle.update(generation, session(ROWS.slice(1), { query: "q" }), "reset")).toBe(
      true,
    );
    expect(lifecycle.close(generation)).toBe(true);
    expect(callbacks.open).toHaveBeenCalledWith(identity, expect.objectContaining({ open: true }));
    expect(callbacks.update).toHaveBeenCalledWith(
      generation,
      expect.objectContaining({ query: "q" }),
    );
    expect(callbacks.close).toHaveBeenCalledWith(generation);
    expect(menu.snapshot().open).toBe(false);
  });

  it("resets selection for a query update but preserves stable identity on refresh", () => {
    const { menu, lifecycle } = createInternalSuggestionLifecycle<Row>();
    const opened = lifecycle.open(session([{ id: "a" }, { id: "b" }, { id: "c" }]));
    menu.setActiveId("b");

    const queryGeneration = nextGeneration(lifecycle, opened.sessionId);
    lifecycle.update(
      queryGeneration,
      session([{ id: "c" }, { id: "b" }, { id: "a" }], { query: "new" }),
      "reset",
    );
    expect(menu.snapshot()).toMatchObject({ activeId: "c", activeIndex: 0 });

    menu.setActiveId("b");
    const refreshGeneration = nextGeneration(lifecycle, opened.sessionId);
    lifecycle.update(
      refreshGeneration,
      session([{ id: "c", label: "changed" }, { id: "a" }, { id: "b", label: "refreshed" }]),
      "preserve-active",
    );
    expect(menu.snapshot()).toMatchObject({ activeId: "b", activeIndex: 2 });
  });

  it("falls back to the first choosable row when a preserved row disappears", () => {
    const { menu, lifecycle } = createInternalSuggestionLifecycle<Row>();
    const opened = lifecycle.open(session([{ id: "a" }, { id: "b" }]));
    menu.setActiveId("b");
    const generation = nextGeneration(lifecycle, opened.sessionId);
    lifecycle.update(
      generation,
      session([{ id: "blocked", blocked: true }, { id: "c" }], { choosable: choosableRow }),
      "preserve-active",
    );
    expect(menu.snapshot()).toMatchObject({ activeId: "c", activeIndex: 1 });
  });

  it("discards old generations and old sessions without publishing", () => {
    const { menu, lifecycle } = createInternalSuggestionLifecycle<Row>();
    const first = lifecycle.open(session([{ id: "first" }]));
    const staleGeneration = nextGeneration(lifecycle, first.sessionId);
    const currentGeneration = nextGeneration(lifecycle, first.sessionId);
    const listener = vi.fn();
    menu.subscribe(listener);

    expect(lifecycle.update(staleGeneration, session([{ id: "stale" }]), "reset")).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(lifecycle.update(currentGeneration, session([{ id: "current" }]), "reset")).toBe(true);

    const second = lifecycle.open(session([{ id: "second" }]));
    listener.mockClear();
    expect(lifecycle.update(currentGeneration, session([{ id: "old" }]), "reset")).toBe(false);
    expect(lifecycle.close(currentGeneration)).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(menu.snapshot().activeId).toBe("second");
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  it("refuses an older generation of the current session from closing it", () => {
    const { menu, lifecycle } = createInternalSuggestionLifecycle<Row>();
    const opened = lifecycle.open(session([{ id: "current" }]));
    const stale = nextGeneration(lifecycle, opened.sessionId);
    const current = nextGeneration(lifecycle, opened.sessionId);

    expect(lifecycle.close(stale)).toBe(false);
    expect(menu.snapshot().open).toBe(true);
    expect(lifecycle.close(current)).toBe(true);
    expect(menu.snapshot().open).toBe(false);
  });

  it("finishes an open event before a callback's reentrant open", () => {
    const events: string[] = [];
    let innerSessionId = "";
    let lifecycle!: ReturnType<typeof createInternalSuggestionLifecycle<Row>>["lifecycle"];
    const created = createInternalSuggestionLifecycle<Row>({
      open: (identity, published) => {
        events.push(`callback:${identity.sessionId}:${published.activeId}`);
        if (published.activeId === "outer") {
          const inner = lifecycle.open(session([{ id: "inner" }]));
          innerSessionId = inner.sessionId;
          events.push(`returned:${inner.sessionId}`);
        }
      },
    });
    lifecycle = created.lifecycle;
    created.menu.subscribe(() => events.push(`subscriber:${created.menu.snapshot().activeId}`));

    const outer = lifecycle.open(session([{ id: "outer" }]));

    expect(events).toEqual([
      `callback:${outer.sessionId}:outer`,
      `returned:${innerSessionId}`,
      "subscriber:outer",
      `callback:${innerSessionId}:inner`,
      "subscriber:inner",
    ]);
    expect(created.menu.snapshot().activeId).toBe("inner");
  });

  it("finishes an update event before a subscriber's reentrant close", () => {
    const callbacks = { update: vi.fn(), close: vi.fn() };
    const { menu, lifecycle } = createInternalSuggestionLifecycle<Row>(callbacks);
    const opened = lifecycle.open(session([{ id: "before" }]));
    const current = nextGeneration(lifecycle, opened.sessionId);
    const publications: string[] = [];
    menu.subscribe(() => {
      publications.push(menu.snapshot().activeId ?? "closed");
      if (menu.snapshot().activeId === "after") lifecycle.close(current);
    });

    expect(lifecycle.update(current, session([{ id: "after" }]), "reset")).toBe(true);
    expect(callbacks.update).toHaveBeenCalledWith(
      current,
      expect.objectContaining({ activeId: "after", open: true }),
    );
    expect(callbacks.close).toHaveBeenCalledWith(current);
    expect(publications).toEqual(["after", "closed"]);
    expect(menu.snapshot().open).toBe(false);
  });
});

describe("menu movement and choice", () => {
  it("steps over refusing rows and chooses by the active stable identity", () => {
    const choose = vi.fn();
    const { menu, lifecycle } = createInternalSuggestionLifecycle<Row>();
    lifecycle.open(session(ROWS, { choose, choosable: choosableRow }));

    expect(menu.snapshot()).toMatchObject({ activeId: "quote", activeIndex: 1 });
    expect(menu.move(1)).toBe(true);
    expect(menu.snapshot()).toMatchObject({ activeId: "code", activeIndex: 3 });
    expect(menu.chooseActive()).toBe(true);
    expect(choose).toHaveBeenCalledWith(ROWS[3], "enter");
  });

  it("supports edge movement, distinct choice actions, and Escape backtracking", () => {
    const choose = vi.fn();
    const backtrack = vi.fn(() => true);
    const { menu, lifecycle } = createInternalSuggestionLifecycle<Row>();
    lifecycle.open(session(ROWS, { choose, choosable: choosableRow, backtrack }));

    expect(menu.moveTo("last")).toBe(true);
    expect(menu.snapshot().activeId).toBe("code");
    expect(menu.moveTo("first")).toBe(true);
    expect(menu.snapshot().activeId).toBe("quote");
    expect(menu.chooseActive("tab")).toBe(true);
    expect(choose).toHaveBeenCalledWith(ROWS[1], "tab");
    expect(menu.backtrack()).toBe(true);
    expect(backtrack).toHaveBeenCalledOnce();
  });

  it("hands keys back when every visible row refuses", () => {
    const { menu, lifecycle } = createInternalSuggestionLifecycle<Row>();
    lifecycle.open(session([{ id: "heading", blocked: true }], { choosable: choosableRow }));
    expect(menu.snapshot()).toMatchObject({ open: true, activeId: null, activeIndex: -1 });
    expect(menu.move(1)).toBe(false);
    expect(menu.chooseActive()).toBe(false);
  });
});
