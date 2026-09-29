// @vitest-environment jsdom
/** A refused title rename reopens the field, and committing it again retries. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TitleEditSlot } from "./TitleEditSlot";

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

const field = () => host.querySelector("input");

function type(value: string) {
  const input = field() as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(key: string) {
  await act(async () => {
    field()?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

it("reopens a refused rename with the writer's text, and Enter retries it", async () => {
  const rename = vi
    .fn<(title: string) => Promise<unknown>>()
    .mockRejectedValueOnce(new Error("refused"))
    .mockResolvedValueOnce(undefined);
  act(() =>
    root.render(
      <TitleEditSlot label="Rename" failure="Couldn’t rename." rename={rename}>
        {({ start, triggerRef }) => (
          <button ref={triggerRef} type="button" onClick={() => start("Arc 3")}>
            Arc 3
          </button>
        )}
      </TitleEditSlot>,
    ),
  );
  act(() => host.querySelector("button")?.click());
  type("Arc 4");
  await press("Enter");

  expect(rename).toHaveBeenCalledWith("Arc 4");
  expect(field()?.value).toBe("Arc 4");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Couldn’t rename.");

  await press("Enter");
  expect(rename).toHaveBeenCalledTimes(2);
  expect(field()).toBeNull();
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
