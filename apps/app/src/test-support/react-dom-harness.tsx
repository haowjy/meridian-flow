/**
 * JSDOM-backed React root lifecycle for node-environment component tests:
 * swaps browser globals in, renders under act, and guarantees teardown
 * (unmount, global restore, window close) even when the callback throws.
 */
import { createRequire } from "node:module";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as {
  JSDOM: new (html: string) => { window: Window & typeof globalThis & { close: () => void } };
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

export async function withReactRoot(
  node: ReactNode,
  run?: () => Promise<void> | void,
  options: WithReactRootOptions = {},
): Promise<void> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousActEnvironment = (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
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
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    dom.window.close();
  }
}
