/**
 * Selection is explicit or it is the open row: Ctrl/Cmd-click toggles rows in
 * and out (starting from the open row) without ever re-adding what the writer
 * removed, and a row reselected after a move stays the selection on its own.
 */
import { act } from "react";
import { expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { type DragEntry, entryKey } from "./entry";
import { EntrySelectionProvider, useEntrySelection, useEntrySelectionRow } from "./selection";

vi.mock("@/hooks/use-phone-shell", () => ({ usePhoneShell: () => false }));

function entry(id: string): DragEntry {
  return { ref: { kind: "file", id }, name: id, uri: `scratch://@w/${id}`, movable: true };
}

function Row({ row, active }: { row: DragEntry; active: boolean }) {
  const { selection, selected, rowProps } = useEntrySelectionRow(row, active);
  return (
    <button
      type="button"
      id={row.ref.id}
      data-selected={selected}
      {...rowProps}
      onClick={(event) => selection?.click(row, event)}
    />
  );
}

function List({ rows }: { rows: DragEntry[] }) {
  const selection = useEntrySelection();
  return (
    <EntrySelectionProvider selection={selection}>
      <button
        type="button"
        id="moved"
        onClick={() => selection.replace([entryKey(rows[1]?.ref ?? entry("").ref)])}
      />
      {rows.map((row, index) => (
        <Row key={row.ref.id} row={row} active={index === 0} />
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
