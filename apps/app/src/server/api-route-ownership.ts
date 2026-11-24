// keep: Route-owner rules are ordered; exact app routes precede server families and every new server family must be listed

export type ApiRouteOwner = "app" | "server";

interface ApiRouteOwnershipRule {
  owner: ApiRouteOwner;
  path: string;
  match: "exact" | "family";
}

const API_ROUTE_OWNERSHIP = [
  { owner: "app", path: "/api/auth/callback", match: "exact" },
  { owner: "server", path: "/api/auth", match: "family" },
  { owner: "server", path: "/api/agents", match: "family" },
  { owner: "server", path: "/api/skills", match: "exact" },
  { owner: "server", path: "/api/models", match: "exact" },
  { owner: "server", path: "/api/image-proxy", match: "exact" },
  { owner: "server", path: "/api/account", match: "family" },
  { owner: "server", path: "/api/billing", match: "family" },
  { owner: "server", path: "/api/threads", match: "family" },
  { owner: "server", path: "/api/projects", match: "family" },
  { owner: "server", path: "/api/imports", match: "family" },
  { owner: "server", path: "/api/works", match: "family" },
  { owner: "server", path: "/api/mcp", match: "family" },
  { owner: "server", path: "/api/commands", match: "family" },
  { owner: "server", path: "/api/documents", match: "family" },
  { owner: "server", path: "/api/debug", match: "family" },
  { owner: "server", path: "/api/diagnostics/failures", match: "exact" },
  { owner: "server", path: "/api/object-store", match: "family" },
  { owner: "server", path: "/ws/loro", match: "exact" },
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
