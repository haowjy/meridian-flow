/**
 * Selection is explicit or it is the open row: Ctrl/Cmd-click toggles rows in
 * and out (starting from the open row) without ever re-adding what the writer
 * removed, a row reselected after a move stays the selection on its own, and a
 * drag that spans systems carries everything but moves nowhere.
 */
import { act } from "react";
import { expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { activeEntryDrag, endEntryDrag, startEntryDrag } from "./drag-session";
import type { SelectableEntry } from "./entry";
import { EntrySelectionProvider, useEntrySelection, useEntrySelectionRow } from "./selection";

vi.mock("@/hooks/use-phone-shell", () => ({ usePhoneShell: () => false }));

const root = { entryId: "root", uri: "scratch://@w/" };
function entry(id: string, owner: SelectableEntry["owner"] = { workId: "w" }): SelectableEntry {
  return {
    key: `scratch:${id}`,
    kind: "file",
    id,
    name: id,
    path: id,
    uri: `scratch://@w/${id}`,
    parentId: "root",
    catalogRootId: "root",
    origin: { scheme: "scratch", owner, root, entryId: "root" },
    movable: true,
    scheme: "scratch",
    owner,
  };
}

function Row({ row, active }: { row: SelectableEntry; active: boolean }) {
  const { selection, selected, rowProps } = useEntrySelectionRow(row, active);
  return (
    <button
      type="button"
      id={row.id}
      data-selected={selected}
      {...rowProps}
      onClick={(event) => selection?.click(row, event)}
    />
  );
}

function List({ rows }: { rows: SelectableEntry[] }) {
  const selection = useEntrySelection();
  return (
    <EntrySelectionProvider selection={selection}>
      <button type="button" id="moved" onClick={() => selection.replace([rows[1]?.key ?? ""])} />
      {rows.map((row, index) => (
        <Row key={row.key} row={row} active={index === 0} />
      ))}
    </EntrySelectionProvider>
  );
}

async function click(id: string, ctrlKey = false) {
  await act(async () => {
    document
      .getElementById(id)
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, ctrlKey }));
  });
}
const selected = (id: string) => document.getElementById(id)?.getAttribute("data-selected");

it("toggles rows in and out from the open row", async () => {
  await withReactRoot(<List rows={[entry("a"), entry("b")]} />, async () => {
    await click("b", true);
    expect([selected("a"), selected("b")]).toEqual(["true", "true"]);
    await click("a", true);
    expect([selected("a"), selected("b")]).toEqual(["false", "true"]);
    await click("b", true);
    expect([selected("a"), selected("b")]).toEqual(["false", "false"]);
  });
});

it("keeps a lone moved row as the selection, not the open row", async () => {
  await withReactRoot(<List rows={[entry("a"), entry("b"), entry("c")]} />, async () => {
    await click("moved");
    await click("c", true);
    expect([selected("a"), selected("b"), selected("c")]).toEqual(["false", "true", "true"]);
  });
});

it("moves nowhere when the dragged rows span systems", async () => {
  await withReactRoot(null, () => {
    vi.stubGlobal("requestAnimationFrame", () => 0);
    const transfer = { setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: "" };
    startEntryDrag({ dataTransfer: transfer } as never, [
      entry("a"),
      entry("b", { rootThreadId: "t1" }),
    ]);
    expect(activeEntryDrag()?.entries).toHaveLength(2);
    expect(activeEntryDrag()?.system).toBeNull();
    endEntryDrag();
    vi.unstubAllGlobals();
  });
});
