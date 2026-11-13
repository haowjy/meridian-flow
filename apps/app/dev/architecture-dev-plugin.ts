import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

/** The map's directory, and the short URL that opens it. */
const MAP_DIR = "/.context/system-architecture/";
export const ARCHITECTURE_ENTRY = "/architecture/";

/** What the map's directory may serve: pages, scripts, styles and images, not its check scripts. */
const MAP_EXTENSIONS: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const MARKDOWN = "text/markdown; charset=utf-8";

export type ArchitectureRequest =
  | { kind: "pass" }
  | { kind: "redirect"; to: string }
  | { kind: "reject" }
  | { kind: "file"; file: string; type: string };

/**
 * What the dev server does with a request path. Served, at their repo paths: the map directory,
 * and any `.md` under a `.context/` directory (the state machine pages the map renders).
 * Everything else, source and `.env` included, passes to the app; a path that climbs
 * (`..`, an encoded one, a backslash or NUL) is rejected.
 */
export function resolveArchitectureRequest(rawPath: string, repoRoot: string): ArchitectureRequest {
  let pathname: string;
  try {
    pathname = decodeURIComponent(rawPath);
  } catch {
    return { kind: "reject" };
  }
  if (pathname === ARCHITECTURE_ENTRY.slice(0, -1) || pathname === ARCHITECTURE_ENTRY) {
    return { kind: "redirect", to: `${MAP_DIR}index.html` };
  }
  const inMap = pathname.startsWith(MAP_DIR);
  if (!inMap && !pathname.endsWith(".md")) return { kind: "pass" };
  if (/(^|\/)\.\.(\/|$)|\\|\0/.test(pathname)) return { kind: "reject" };

  const extension = path.extname(pathname);
  const type = inMap ? MAP_EXTENSIONS[extension] : extension === ".md" ? MARKDOWN : undefined;
  const segments = pathname.split("/");
  const isPage = !inMap && segments.includes(".context") && !segments.includes("node_modules");
  if (!type || (!inMap && !isPage)) return { kind: "pass" };

  const file = path.join(repoRoot, pathname);
  // A symlink inside the allowed paths must not lead out of the repo.
  let real: string;
  try {
    real = fs.realpathSync(file);
  } catch {
    return { kind: "pass" };
  }
  const root = fs.realpathSync(repoRoot);
  if (!real.startsWith(root + path.sep) || !fs.statSync(real).isFile()) return { kind: "pass" };
  return { kind: "file", file: real, type };
}

/**
 * Dev only: the architecture map, served from the checkout at /architecture/. The production
 * build never includes it (`apply: "serve"`).
 */
export function architectureDevPlugin(repoRoot: string): Plugin {
  return {
    name: "meridian-architecture-dev",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if ((req.method !== "GET" && req.method !== "HEAD") || !req.url) {
          next();
          return;
        }
        const result = resolveArchitectureRequest(req.url.split(/[?#]/)[0], repoRoot);
        if (result.kind === "pass") {
          next();
        } else if (result.kind === "redirect") {
          res.statusCode = 302;
          res.setHeader("location", result.to);
          res.end();
        } else if (result.kind === "reject") {
          res.statusCode = 403;
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end("Not served");
        } else {
          res.setHeader("content-type", result.type);
          res.setHeader("cache-control", "no-cache");
          res.setHeader("x-content-type-options", "nosniff");
          if (req.method === "HEAD") res.end();
          else fs.createReadStream(result.file).pipe(res);
        }
      });
    },
  };
}
