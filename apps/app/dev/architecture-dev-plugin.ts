import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

/** The map's directory, and the short URL that opens it. */
const MAP_DIR = "/.context/system-architecture/";
export const ARCHITECTURE_ENTRY = "/architecture/";

const MARKDOWN = "text/markdown; charset=utf-8";

/** What the map's directory may serve: pages, scripts, styles and images, not its check scripts. */
const MAP_EXTENSIONS: Record<string, string> = {
  ".md": MARKDOWN,
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

export type ArchitectureRequest =
  | { kind: "pass" }
  | { kind: "redirect"; to: string }
  | { kind: "reject" }
  | { kind: "file"; file: string; type: string };

/**
 * What the dev server does with a request path. Served, at their repo paths: the map directory,
 * and any `.md` under a `.context/` directory (the state machine pages the map renders).
 * Everything else, source and `.env` included, passes to the app; a path that climbs
 * (`..`, an encoded one, a backslash or NUL) is rejected. A symlink is followed only if the
 * file it points at is also in the repo and would be served at its own path.
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
  if (/(^|\/)\.\.(\/|$)|\\|\0/.test(pathname))
    return pathname.startsWith(MAP_DIR) || pathname.endsWith(".md")
      ? { kind: "reject" }
      : { kind: "pass" };
  const type = servedType(pathname);
  if (!type) return { kind: "pass" };

  // A symlink inside the allowed paths must not lead out of the repo or to a file the rules wouldn't serve.
  let real: string;
  try {
    real = fs.realpathSync(path.join(repoRoot, pathname));
  } catch {
    return { kind: "pass" };
  }
  const root = fs.realpathSync(repoRoot);
  const realPathname = `/${path.relative(root, real).split(path.sep).join("/")}`;
  if (!real.startsWith(root + path.sep) || !servedType(realPathname) || !fs.statSync(real).isFile())
    return { kind: "pass" };
  return { kind: "file", file: real, type };
}

/** The content type a repo path is served as, or undefined: the map directory by extension, any `.md` under a `.context/` directory. */
function servedType(pathname: string): string | undefined {
  const extension = path.extname(pathname);
  if (pathname.startsWith(MAP_DIR)) return MAP_EXTENSIONS[extension];
  const segments = pathname.split("/");
  return extension === ".md" && segments.includes(".context") && !segments.includes("node_modules")
    ? MARKDOWN
    : undefined;
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
          else {
            const stream = fs.createReadStream(result.file);
            // The file can vanish between the stat and the read.
            stream.on("error", () => res.destroy());
            stream.pipe(res);
          }
        }
      });
    },
  };
}
