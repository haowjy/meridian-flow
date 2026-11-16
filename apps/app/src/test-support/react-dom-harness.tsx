/**
 * JSDOM-backed React root lifecycle for node-environment component tests:
 * swaps browser globals in, renders under act, and guarantees teardown
 * (unmount, global restore, window close) even when the callback throws.
 */
import { createRequire } from "node:module";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { installJsdomLayoutFallbacks } from "./jsdom-layout";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as {
  JSDOM: new (
    html: string,
    options?: { url?: string },
  ) => { window: Window & typeof globalThis & { close: () => void } };
};

type ActGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

export type WithReactRootOptions = {
  /**
   * Drain one real macrotask after unmount, before restoring globals. Needed
   * when a library batches post-render notifications via setTimeout (e.g.
   * TanStack Query) — a late notify against a torn-down window crashes
   * react-dom. Leave off in fake-timer tests, where a real timeout would
   * never resolve.
   */
  drainMacrotask?: boolean;
};

// Under a jsdom test environment `document` is an accessor, so assigning it
// throws; defining the property replaces it either way.
function defineGlobal(name: "window" | "document", descriptor: PropertyDescriptor) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, ...descriptor });
}

function restoreGlobal(name: "window" | "document", previous: PropertyDescriptor | undefined) {
  if (previous) Object.defineProperty(globalThis, name, previous);
  else delete (globalThis as Partial<typeof globalThis>)[name];
}

export async function withReactRoot(
  node: ReactNode,
  run?: () => Promise<void> | void,
  options: WithReactRootOptions = {},
): Promise<void> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "https://app.meridian.test/",
  });
  // A fresh JSDOM is its own realm: the ambient setup shim patched a different
  // Element/Range, so nodes created here need the fallbacks applied to this
  // window's prototypes.
  installJsdomLayoutFallbacks(dom.window as unknown as typeof globalThis);
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousActEnvironment = (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT;
  defineGlobal("window", { value: dom.window });
  defineGlobal("document", { value: dom.window.document });
  (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
  const rootNode = dom.window.document.getElementById("root");
  if (!rootNode) throw new Error("missing root");
  const root = createRoot(rootNode);
  try {
    await act(async () => {
      root.render(node);
    });
    await run?.();
  } finally {
    await act(async () => root.unmount());
    if (options.drainMacrotask) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    restoreGlobal("window", previousWindow);
    restoreGlobal("document", previousDocument);
    (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    dom.window.close();
  }
}
