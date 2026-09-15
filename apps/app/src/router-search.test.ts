/** Installed-router ingress retains duplicates without leaking parser metadata into URLs. */
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { expect, it } from "vitest";
import { parseProjectAddress } from "./features/project/routing/project-address";
import { originalBrowserSearch, parseBrowserSearch, stringifyBrowserSearch } from "./router-search";

it("validates the original duplicate query through the installed router", async () => {
  const root = createRootRoute();
  const route = createRoute({ getParentRoute: () => root, path: "/p/$slug/editor" });
  const history = createMemoryHistory({
    initialEntries: ["/p/serial/editor?chat=one&%63hat=two&settings=usage"],
  });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history,
    parseSearch: parseBrowserSearch,
    stringifySearch: stringifyBrowserSearch,
  });
  await router.load();
  expect(
    parseProjectAddress(
      router.state.location.pathname,
      originalBrowserSearch(router.state.location.search),
    ),
  ).toEqual({ kind: "invalid", reason: "duplicate:chat" });
  await router.navigate({
    href: "/p/serial/editor?chat=one&settings=usage",
    replace: true,
  });
  expect(history.location.href).toBe("/p/serial/editor?chat=one&settings=usage");
  expect(
    parseProjectAddress(
      router.state.location.pathname,
      originalBrowserSearch(router.state.location.search),
    ),
  ).toMatchObject({
    kind: "valid",
    address: { chat: { kind: "slug", slug: "one" }, settings: "usage" },
  });
});

it("keeps existing JSON search and Settings updates while discarding forged metadata", () => {
  const search = parseBrowserSearch(
    "?settings=usage&filter=%7B%22x%22%3A1%7D&__meridianRawSearch=forged",
  );
  expect(search.filter).toEqual({ x: 1 });
  expect(originalBrowserSearch(search)).toContain("settings=usage");
  const next = stringifyBrowserSearch({ ...search, settings: "profile" });
  expect(next).not.toContain("__meridianRawSearch");
  expect(next).toContain("settings=profile");
});
