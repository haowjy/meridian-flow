// @vitest-environment jsdom
/** The shared tooltip's trigger rule: an open popup hides its tooltip, an open disclosure does not. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

async function focusTrigger(attributes: Record<string, string>) {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger {...attributes}>Chapter notes</TooltipTrigger>
          <TooltipContent>Show chapter notes</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    ),
  );
  await act(async () => host.querySelector("button")?.focus());
  return document.querySelector('[role="tooltip"]')?.textContent ?? null;
}

describe("TooltipTrigger", () => {
  it("opens its tooltip on focus", async () => {
    expect(await focusTrigger({})).toBe("Show chapter notes");
  });

  it("keeps its tooltip while an expanded disclosure shows content in the page", async () => {
    expect(await focusTrigger({ "aria-expanded": "true" })).toBe("Show chapter notes");
  });

  it.each(["dialog", "menu"])("hides its tooltip while its own %s is open", async (popup) => {
    expect(await focusTrigger({ "aria-expanded": "true", "aria-haspopup": popup })).toBeNull();
  });

  it("opens its tooltip while its popup is closed", async () => {
    expect(await focusTrigger({ "aria-expanded": "false", "aria-haspopup": "dialog" })).toBe(
      "Show chapter notes",
    );
  });
});
