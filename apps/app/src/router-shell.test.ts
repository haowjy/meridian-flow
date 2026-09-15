/** Real router regression for warm navigation while network access is unavailable. */
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { expect, it } from "vitest";
import { PERSISTENT_SHELL_OPTIONS } from "./router-shell";

it("retains a warm parent across same-href state changes but honors explicit invalidation", async () => {
  let calls = 0;
  let offline = false;
  let authCalls = 0;
  const root = createRootRoute({
    ...PERSISTENT_SHELL_OPTIONS,
    loader: async () => {
      authCalls += 1;
      if (offline) throw new Error("offline auth");
      return { accountId: "account" };
    },
  });
  const parent = createRoute({
    ...PERSISTENT_SHELL_OPTIONS,
    getParentRoute: () => root,
    path: "/p/$project",
    loader: async () => {
      calls += 1;
      if (offline) throw new Error("offline");
      return { identity: "project" };
    },
  });
  const child = createRoute({ getParentRoute: () => parent, path: "$" });
  const history = createMemoryHistory({ initialEntries: ["/p/book/editor"] });
  const router = createRouter({
    routeTree: root.addChildren([parent.addChildren([child])]),
    history,
  });
  await router.load();
  expect(calls).toBe(1);
  expect(authCalls).toBe(1);
  offline = true;
  history.replace("/p/book/editor", { localDraft: "draft" } as never);
  await router.load();
  await router.navigate({ href: "/p/book/chats" });
  expect(calls).toBe(1);
  expect(authCalls).toBe(1);
  expect(router.state.matches.every((match) => match.status === "success")).toBe(true);
  offline = false;
  await router.invalidate();
  expect(calls).toBe(2);
  expect(authCalls).toBe(2);
});
