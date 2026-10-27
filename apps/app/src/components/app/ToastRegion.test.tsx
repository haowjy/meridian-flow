// @vitest-environment jsdom
/** Registry order, the "seen" signal an owner times a clean Done on, and what each layout folds away. */
import { act, type ReactNode } from "react";
import { expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { ToastRegion } from "./ToastRegion";
import { createToastRegistry, ToastRegistryProvider } from "./toast-registry";

// JSDOM reports "prerender" until told otherwise.
let tab: DocumentVisibilityState = "visible";
function Environment({ phone, children }: { phone: boolean; children: ReactNode }) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => tab });
  window.matchMedia = () =>
    ({
      matches: phone,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList;
  return children;
}

const mount = (phone: boolean, registry = createToastRegistry()) =>
  [
    registry,
    <Environment phone={phone}>
      <ToastRegistryProvider registry={registry}>
        <TooltipProvider>
          <ToastRegion />
        </TooltipProvider>
      </ToastRegistryProvider>
    </Environment>,
  ] as const;
const seen = (registry: ReturnType<typeof createToastRegistry>) => [
  ...registry.getSnapshot().visible,
];
const keys = (registry: ReturnType<typeof createToastRegistry>) =>
  registry.getSnapshot().toasts.map((toast) => toast.key);

it("keeps a toast's place on update, and reveal brings it forward expanded", () => {
  const registry = createToastRegistry();
  registry.show("a", { title: "A" });
  registry.show("b", { title: "B" });
  registry.show("a", { title: "A2", progress: 10 });
  registry.setCollapsed("a", true);
  expect(keys(registry)).toEqual(["a", "b"]);
  registry.reveal("a");
  expect(keys(registry)).toEqual(["b", "a"]);
  expect(registry.getSnapshot().collapsed.has("a")).toBe(false);
  registry.update("gone", { title: "x" });
  expect(keys(registry)).toEqual(["b", "a"]);
});

it("desktop reports only the newest three as seen, and only in a visible tab", async () => {
  const [registry, tree] = mount(false);
  await withReactRoot(tree, async () => {
    await act(async () => {
      for (const key of ["a", "b", "c", "d", "e"]) registry.show(key, { title: key });
    });
    expect(seen(registry).sort()).toEqual(["c", "d", "e"]);
    expect(document.body.textContent).toContain("+2 more");

    await act(async () => {
      registry.remove("e");
    });
    expect(seen(registry).sort()).toEqual(["b", "c", "d"]);

    tab = "hidden";
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(seen(registry)).toEqual([]);
    tab = "visible";
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(seen(registry)).toHaveLength(3);
  });
});

it("phone counts a toast as seen only while it is shown as itself", async () => {
  const [registry, tree] = mount(true);
  await withReactRoot(tree, async () => {
    await act(async () => registry.show("a", { title: "Done", detail: "3 files" }));
    expect(seen(registry)).toEqual(["a"]);
    await act(async () => {
      registry.show("b", { title: "B", progress: 20 });
      registry.show("c", { title: "C", progress: "indeterminate" });
    });
    expect(document.body.textContent).toContain("2 in progress");
    expect(seen(registry)).toEqual([]);
  });
});
