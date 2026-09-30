// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SegmentedTabs } from "./segmented-tabs";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("SegmentedTabs close actions", () => {
  it("calls close without changing the tab for click and Delete", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const close = vi.fn();
    const onChange = vi.fn();

    await act(async () => {
      root?.render(
        <SegmentedTabs
          label="Dock view"
          value="file"
          onChange={onChange}
          options={[
            {
              value: "file",
              label: "Notes.md",
              closeAction: { icon: <span>X</span>, onClose: close },
            },
          ]}
        />,
      );
    });

    const tablist = host.querySelector('[role="tablist"]');
    const tab = tablist?.querySelector<HTMLButtonElement>('[role="tab"]');

    await act(async () => {
      tab?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();

    await act(async () => {
      tab?.querySelector<HTMLElement>("[data-segmented-tab-close]")?.click();
    });
    expect(close).toHaveBeenCalledTimes(2);
    expect(onChange).not.toHaveBeenCalled();
  });
});
