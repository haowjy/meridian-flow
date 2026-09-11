import { createRouter } from "@tanstack/react-router";
import { parseBrowserSearch, stringifyBrowserSearch } from "./router-search";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({
    routeTree,
    parseSearch: parseBrowserSearch,
    stringifySearch: stringifyBrowserSearch,
    scrollRestoration: true,
    defaultPendingMinMs: 0,
  });
}
