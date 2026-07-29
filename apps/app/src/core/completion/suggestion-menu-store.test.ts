/**
 * The half of law 5 the store owns: a row a lane will refuse is visible, but
 * never where a key lands.
 *
 * Both typed-under menus read this, so the rule is tested once here rather
 * than in each lane. The other half — that a refusing row still shows and says
 * why — belongs to the surface.
 */
import { describe, expect, it, vi } from "vitest";

import { createSuggestionMenu } from "./suggestion-menu-store";

type Row = { id: string; blocked?: boolean };

const ROWS: Row[] = [
  { id: "heading", blocked: true },
  { id: "quote" },
  { id: "table", blocked: true },
  { id: "code" },
];

function openWith(items: Row[], choosable?: (item: Row) => boolean) {
  const { menu, controller } = createSuggestionMenu<Row>();
  const choose = vi.fn();
  controller.open({
    items,
    query: "",
    anchorRect: () => null,
    label: "Insert block",
    meta: null,
    choose,
    choosable,
    dismiss: () => {},
  });
  return { menu, choose };
}

const choosableRow = (item: Row) => item.blocked !== true;

describe("a menu with rows its lane refuses", () => {
  it("opens on the first row that can be chosen", () => {
    const { menu } = openWith(ROWS, choosableRow);
    expect(menu.snapshot().activeIndex).toBe(1);
  });

  it("steps the highlight over refusing rows in both directions", () => {
    const { menu } = openWith(ROWS, choosableRow);

    expect(menu.move(1)).toBe(true);
    expect(menu.snapshot().activeIndex).toBe(3);
    expect(menu.move(1)).toBe(true);
    expect(menu.snapshot().activeIndex).toBe(1);
    expect(menu.move(-1)).toBe(true);
    expect(menu.snapshot().activeIndex).toBe(3);
  });

  it("declines a refusing row, by key or by pointer", () => {
    const { menu, choose } = openWith(ROWS, choosableRow);

    expect(menu.choose(0)).toBe(false);
    expect(choose).not.toHaveBeenCalled();

    menu.setActiveIndex(2);
    expect(menu.snapshot().activeIndex).toBe(1);

    expect(menu.chooseActive()).toBe(true);
    expect(choose).toHaveBeenCalledWith(ROWS[1]);
  });

  it("hands the keys back when every row refuses", () => {
    const { menu, choose } = openWith([{ id: "heading", blocked: true }], choosableRow);

    // The menu is still on screen, and still says why: what it stops doing is
    // taking keystrokes that would do nothing.
    expect(menu.snapshot().open).toBe(true);
    expect(menu.snapshot().activeIndex).toBe(-1);
    expect(menu.move(1)).toBe(false);
    expect(menu.chooseActive()).toBe(false);
    expect(choose).not.toHaveBeenCalled();
  });

  it("leaves a lane that refuses nothing exactly as it was", () => {
    const { menu, choose } = openWith(ROWS);

    expect(menu.snapshot().activeIndex).toBe(0);
    expect(menu.move(1)).toBe(true);
    expect(menu.snapshot().activeIndex).toBe(1);
    expect(menu.move(-1)).toBe(true);
    expect(menu.snapshot().activeIndex).toBe(0);
    expect(menu.chooseActive()).toBe(true);
    expect(choose).toHaveBeenCalledWith(ROWS[0]);
  });
});
