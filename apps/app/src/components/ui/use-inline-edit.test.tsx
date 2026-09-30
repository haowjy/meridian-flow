// @vitest-environment jsdom
/** The shared inline-edit commit/cancel protocol. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { typeInto } from "@/test-support/react-dom-harness";
import { type UseInlineEditOptions, useInlineEdit } from "./use-inline-edit";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function Field(props: UseInlineEditOptions) {
  const edit = useInlineEdit(props);
  return (
    <>
      <input {...edit.inputProps} />
      <p data-issue>{edit.issue?.message}</p>
    </>
  );
}

function render(overrides: Partial<UseInlineEditOptions> = {}) {
  const onCommit = vi.fn<UseInlineEditOptions["onCommit"]>();
  const onCancel = vi.fn();
  act(() =>
    root.render(<Field initial="Arc 3" onCommit={onCommit} onCancel={onCancel} {...overrides} />),
  );
  const input = host.querySelector("input") as HTMLInputElement;
  return {
    input,
    onCommit: overrides.onCommit ?? onCommit,
    onCancel: overrides.onCancel ?? onCancel,
  };
}

function type(input: HTMLInputElement, value: string) {
  act(() => {
    typeInto(input, value);
  });
}

function key(input: HTMLInputElement, name: string, init: KeyboardEventInit = {}) {
  act(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, ...init }));
  });
}

describe("useInlineEdit", () => {
  it("commits the trimmed draft on Enter, once, even when blur follows", async () => {
    const { input, onCommit } = render();
    type(input, "  Arc 4  ");
    key(input, "Enter");
    await act(async () => input.blur());
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("Arc 4");
  });

  it("cancels an unchanged draft", () => {
    const same = render();
    type(same.input, "Arc 3 ");
    key(same.input, "Enter");
    expect(same.onCommit).not.toHaveBeenCalled();
    expect(same.onCancel).toHaveBeenCalledTimes(1);
  });

  it("Escape cancels and the following blur does nothing", () => {
    const { input, onCommit, onCancel } = render();
    type(input, "Arc 4");
    key(input, "Escape");
    act(() => input.blur());
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("ignores Enter while an IME composition is open", () => {
    const { input, onCommit } = render();
    type(input, "Arc 4");
    key(input, "Enter", { isComposing: true });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("a blocking issue keeps the field open", () => {
    const { input, onCommit, onCancel } = render({
      validate: (draft) => (draft.includes("/") ? { level: "error", message: "No slashes" } : null),
    });
    type(input, "Arc/4");
    expect(host.querySelector("[data-issue]")?.textContent).toBe("No slashes");
    key(input, "Enter");
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("a failed commit stays open with the error, and a retry commits again", async () => {
    const onCommit = vi
      .fn<UseInlineEditOptions["onCommit"]>()
      .mockRejectedValueOnce(new Error("Couldn't save"))
      .mockResolvedValueOnce(undefined);
    const { input } = render({ onCommit });
    type(input, "Arc 4");
    await act(async () => key(input, "Enter"));
    expect(host.querySelector("[data-issue]")?.textContent).toBe("Couldn't save");
    await act(async () => key(input, "Enter"));
    expect(onCommit).toHaveBeenCalledTimes(2);
  });
});
