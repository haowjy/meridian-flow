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
  drainMacrotask?: boolean;
};

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
