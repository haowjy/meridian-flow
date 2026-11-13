import { createRouter } from "@tanstack/react-router";
import { parseBrowserSearch, stringifyBrowserSearch } from "./router-search";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({
    routeTree,
    parseSearch: parseBrowserSearch,
    stringifySearch: stringifyBrowserSearch,
    // The project shell owns its scrollers: the router's restore copies the scroll offset of the
    // route it left onto the same-shaped element of the next one (a chat's transcript), and writes
    // it after the chat has pinned itself to the tail.
    scrollRestoration: ({ location }) => !location.pathname.startsWith("/p/"),
    defaultPendingMinMs: 0,
  });
}
