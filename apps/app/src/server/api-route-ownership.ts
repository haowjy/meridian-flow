/**
 * api-route-ownership — the dev composition root's route-owner inventory.
 * Exact app routes run in TanStack Start; server route families are proxied to
 * `apps/server`. Rules are ordered so an exact app route may live inside a
 * server-owned family without broadening app ownership to sibling routes.
 */

export type ApiRouteOwner = "app" | "server";

interface ApiRouteOwnershipRule {
  owner: ApiRouteOwner;
  path: string;
  match: "exact" | "family";
}

const API_ROUTE_OWNERSHIP = [
  { owner: "app", path: "/api/auth/callback", match: "exact" },
  { owner: "app", path: "/api/auth/dev-login", match: "exact" },
  { owner: "server", path: "/api/auth", match: "family" },
  { owner: "server", path: "/api/agents", match: "exact" },
  { owner: "server", path: "/api/account", match: "family" },
  { owner: "server", path: "/api/billing", match: "family" },
  { owner: "server", path: "/api/packages", match: "family" },
  { owner: "server", path: "/api/threads", match: "family" },
  { owner: "server", path: "/api/projects", match: "family" },
  { owner: "server", path: "/api/works", match: "family" },
  { owner: "server", path: "/api/documents", match: "family" },
  { owner: "server", path: "/api/debug", match: "family" },
  { owner: "server", path: "/api/object-store", match: "family" },
] as const satisfies readonly ApiRouteOwnershipRule[];

export function getApiRouteOwner(pathname: string): ApiRouteOwner | null {
  for (const rule of API_ROUTE_OWNERSHIP) {
    if (
      pathname === rule.path ||
      (rule.match === "family" && pathname.startsWith(`${rule.path}/`))
    ) {
      return rule.owner;
    }
  }
  return null;
}
