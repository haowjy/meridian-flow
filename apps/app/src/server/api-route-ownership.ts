/**
 * api-route-ownership — predicates classifying request paths by owner: thread/
 * workbench/document/object-store API paths proxied to `apps/server` vs
 * `/api/auth/*` paths owned by this app. Single source the dev proxy +
 * middleware consult for routing.
 *
 * `/api/documents/*` (the figure markdown / signed-binary download surface)
 * and `/api/object-store/*` (signed local-blob URL handler) belong to the
 * server too — without them, same-origin downloads 404 against the app
 * shell.
 */
export function isApiOwnedPath(pathname: string): boolean {
  return (
    pathname === "/api/agents" ||
    pathname === "/api/packages" ||
    pathname.startsWith("/api/packages/") ||
    pathname === "/api/threads" ||
    pathname.startsWith("/api/threads/") ||
    pathname === "/api/workbenches" ||
    pathname.startsWith("/api/workbenches/") ||
    pathname === "/api/documents" ||
    pathname.startsWith("/api/documents/") ||
    pathname === "/api/object-store" ||
    pathname.startsWith("/api/object-store/")
  );
}

export function isAppOwnedAuthPath(pathname: string): boolean {
  return pathname.startsWith("/api/auth/");
}
