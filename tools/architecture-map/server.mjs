import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { globRegExp } from "./js/pages.js";
import { readTokens } from "./tokens.mjs";

export const ENTRY = "/architecture/";
const ENGINE_DIR = path.dirname(fileURLToPath(import.meta.url));

const ENGINE_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};
const TEXT_TYPES = { ".md": "text/markdown; charset=utf-8", ".css": "text/css; charset=utf-8" };
const IMAGE_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const ENGINE_FILES = /^\/(?:index\.html|js\/[\w.-]+\.js|styles\/page\.css|vendor\/[\w.-]+\.css)$/;
const REFRESH_MS = 2000;

export async function createArchitectureServer(configFile) {
  const config = (
    await import(
      /* @vite-ignore */ `${pathToFileURL(path.resolve(configFile)).href}?t=${Date.now()}`
    )
  ).default;
  const root = fs.realpathSync(path.resolve(path.dirname(configFile), config.root ?? "."));
  const docs = (config.docs ?? []).map(globRegExp);
  const pagesDir = config.pagesDir;

  let listed = { at: 0, files: new Set(), dirs: new Map() };
  function tracked() {
    if (Date.now() - listed.at < REFRESH_MS) return listed;
    const git = (...args) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
        .split("\0")
        .filter(Boolean);
    const files = new Set([
      ...git("ls-files", "-z"),
      ...git("ls-files", "-z", "--others", "--exclude-standard", "--", pagesDir),
    ]);
    const dirs = new Map();
    for (const file of files) {
      const parts = file.split("/");
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join("/");
        if (!dirs.has(dir)) dirs.set(dir, new Map());
        dirs.get(dir).set(parts[i], i + 1 < parts.length);
      }
    }
    listed = { at: Date.now(), files, dirs };
    return listed;
  }

  const showable = (repoPath) =>
    config.serveSource !== false ||
    repoPath.startsWith(`${pagesDir}/`) ||
    docs.some((re) => re.test(repoPath));
  const reject = {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: "Not served",
  };
  const missing = {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: "Not found",
  };
  const hardened = { "cache-control": "no-cache", "x-content-type-options": "nosniff" };

  function repoResponse(repoPath) {
    const { files, dirs } = tracked();
    if (!showable(repoPath) && !dirs.has(repoPath)) return missing;
    if (dirs.has(repoPath) && !files.has(repoPath)) {
      const entries = [...dirs.get(repoPath)]
        .filter(([name, dir]) =>
          dir
            ? config.serveSource !== false ||
              [...files].some((f) => f.startsWith(`${repoPath}/${name}/`) && showable(f))
            : showable(`${repoPath}/${name}`),
        )
        .map(([name, dir]) => ({ name, dir }))
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
      if (!showable(repoPath) && !entries.length) return missing;
      return {
        status: 200,
        headers: { ...hardened, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(entries),
      };
    }
    if (!files.has(repoPath)) return missing;
    let real;
    try {
      real = fs.realpathSync(path.join(root, repoPath));
    } catch {
      return missing;
    }
    const realPath = path.relative(root, real).split(path.sep).join("/");
    if (
      real !== root &&
      (/^\.\.(\/|$)/.test(realPath) || !files.has(realPath) || !showable(realPath))
    )
      return reject;
    if (!fs.statSync(real).isFile()) return missing;
    const image = IMAGE_TYPES[path.extname(repoPath).toLowerCase()];
    const type = image ?? TEXT_TYPES[path.extname(repoPath)] ?? "text/plain; charset=utf-8";
    if (!image && isBinary(real))
      return {
        status: 415,
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: "Not a text file",
      };
    return {
      status: 200,
      headers: { ...hardened, "content-type": type, "content-security-policy": "sandbox" },
      file: real,
    };
  }

  function tokenSheet() {
    let css;
    try {
      ({ css } = readTokens(root, config.tokens));
    } catch (error) {
      return {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: `The token files didn't read: ${error.message}`,
      };
    }
    return {
      status: 200,
      headers: { ...hardened, "content-type": ENGINE_TYPES[".css"] },
      body: css,
    };
  }

  return function handle(rawPath) {
    let pathname;
    try {
      pathname = decodeURIComponent(rawPath);
    } catch {
      return reject;
    }
    if (pathname === ENTRY.slice(0, -1)) return { status: 302, headers: { location: ENTRY } };
    if (!pathname.startsWith(ENTRY)) return null;
    if (/(^|\/)\.\.?(\/|$)|\\|\0/.test(pathname)) return reject;
    const rest = pathname.slice(ENTRY.length - 1);
    if (rest === "/") return engineFile("/index.html");
    if (rest === "/map.config.mjs")
      return {
        status: 200,
        headers: { ...hardened, "content-type": ENGINE_TYPES[".mjs"] },
        file: path.resolve(configFile),
      };
    if (rest === "/tokens.css") return tokenSheet();
    if (rest.startsWith("/repo/")) {
      const repoPath = rest.slice("/repo/".length).replace(/\/$/, "");
      return repoPath ? repoResponse(repoPath) : missing;
    }
    return ENGINE_FILES.test(rest) ? engineFile(rest) : missing;
  };
}

// keep: scripts come only from this origin and the pinned CDN, so an `<img onerror>` in rendered Markdown never runs; inline styles stay allowed for Mermaid and React Flow
const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function engineFile(rest) {
  const headers = {
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
    "content-type": ENGINE_TYPES[path.extname(rest)] ?? "text/plain",
  };
  if (rest === "/index.html") headers["content-security-policy"] = PAGE_CSP;
  return { status: 200, headers, file: path.join(ENGINE_DIR, rest) };
}

function isBinary(file) {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(8192);
    return buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).includes(0);
  } finally {
    fs.closeSync(fd);
  }
}

export function send(req, res, result) {
  res.statusCode = result.status;
  for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
  if (result.file && req.method !== "HEAD") {
    const stream = fs.createReadStream(result.file);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  } else res.end(req.method === "HEAD" ? undefined : result.body);
}
